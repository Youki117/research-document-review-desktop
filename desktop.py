"""Portable desktop window around the existing Xiasha engine; no external browser."""
import ctypes
from contextlib import contextmanager
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser
from update_client import check_updates

NAME = '研发文档审查·下沙'
HERE = Path(__file__).resolve().parent
FROZEN = bool(getattr(sys, 'frozen', False))
RESOURCES = Path(sys._MEIPASS) if FROZEN else HERE / 'stage'
HOME_DIR = Path(sys.executable).parent if FROZEN else HERE / 'run'
BLANK = {'文本模型': {'API地址': '', '模型名称': '', 'API密钥': ''}}
NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


class AlreadyRunning(Exception):
    pass


class ReviewGuard:
    def __init__(self):
        self._lock = threading.Lock()
        self._generation = 0
        self._sequence = -1
        self._dirty = True
        self._saving = False
        self._update = None

    def check_updates(self):
        if self._update is None:
            self._update = check_updates()
        return self._update

    def open_update(self):
        update = self.check_updates()
        if update.get('available'):
            webbrowser.open(update['url'])
            return True
        return False

    def begin_page(self):
        with self._lock:
            self._generation += 1
            self._sequence = -1
            self._dirty = True
            self._saving = False
            return self._generation

    def update_review_state(self, generation, sequence, dirty, saving):
        if type(generation) is not int or type(sequence) is not int or type(dirty) is not bool or type(saving) is not bool:
            raise ValueError('Invalid window state')
        with self._lock:
            if generation != self._generation or sequence <= self._sequence:
                return False
            self._sequence, self._dirty, self._saving = sequence, dirty, saving
            return True

    def snapshot(self):
        with self._lock:
            return self._dirty, self._saving


@contextmanager
def single_instance(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / '.runtime.lock').open('a+b') as lock:
        if os.name == 'nt':
            import msvcrt
            if lock.seek(0, 2) == 0:
                lock.write(b'0')
                lock.flush()
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise AlreadyRunning() from None
        yield


def validate_config(config):
    section = config.get('文本模型') if isinstance(config, dict) else None
    if not isinstance(section, dict):
        raise ValueError('配置缺少文本模型。')
    for field in BLANK['文本模型']:
        if not isinstance(section.get(field), str) or not section[field].strip() or any(c in section[field] for c in '\r\n'):
            raise ValueError('请完整填写模型地址、名称和密钥，每项一行。')
    address = urllib.parse.urlsplit(section['API地址'])
    if address.scheme not in ('http', 'https') or not address.hostname or address.username or address.password or address.query or address.fragment:
        raise ValueError('请输入无内嵌凭据或查询参数的完整 HTTP(S) Chat Completions 地址。')
    return config


def save_config(path, config):
    validate_config(config)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(path)


def edit_settings(path):
    import tkinter as tk
    from tkinter import ttk, messagebox
    root = tk.Tk()
    root.title(NAME + ' — 模型设置')
    root.geometry('640x300')
    root.resizable(False, False)
    root.option_add('*Font', ('Microsoft YaHei UI', 10))
    try:
        section = json.loads(path.read_text(encoding='utf-8-sig')).get('文本模型', {})
    except (OSError, ValueError):
        section = {}
    frame = ttk.Frame(root, padding=24)
    frame.pack(fill='both', expand=True)
    frame.columnconfigure(1, weight=1)
    values = {}
    for row, field in enumerate(BLANK['文本模型']):
        ttk.Label(frame, text=field).grid(row=row, column=0, sticky='w', padx=(0, 15), pady=8)
        value = tk.StringVar(value=section.get(field, ''))
        ttk.Entry(frame, textvariable=value, show='●' if field == 'API密钥' else '').grid(row=row, column=1, sticky='ew', pady=8)
        values[field] = value
    ttk.Label(frame, text='资料会发送至此模型接口；密钥只保存在本机模型配置中。', wraplength=560).grid(row=3, column=0, columnspan=2, sticky='w', pady=12)

    def save():
        try:
            save_config(path, {'文本模型': {field: value.get().strip() for field, value in values.items()}})
        except (ValueError, OSError) as exc:
            messagebox.showerror('无法保存', str(exc), parent=root)
            return
        root.destroy()
    ttk.Button(frame, text='保存设置', command=save).grid(row=4, column=1, sticky='e', pady=10)
    root.mainloop()


class Engine:
    def __init__(self, resources=RESOURCES, home=HOME_DIR):
        self.home = Path(home)
        self.home.mkdir(parents=True, exist_ok=True)
        self.config = self.home / '模型配置.json'
        self.data = self.home / 'data'
        self.data.mkdir(exist_ok=True)
        if not self.config.exists():
            self.config.write_text(json.dumps(BLANK, ensure_ascii=False, indent=2), encoding='utf-8')
        self.process = subprocess.Popen([str(Path(resources) / 'node.exe'), str(Path(resources) / 'desktop-host.mjs'),
                                         str(self.config), str(self.data)], cwd=self.home,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        text=True, encoding='utf-8', creationflags=NO_WINDOW)
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(self.process.stdout.readline()), daemon=True).start()
        try:
            port = json.loads(ready.get(timeout=30))['port']
            if type(port) is not int or not 1 <= port <= 65535:
                raise ValueError()
            self.url = f'http://127.0.0.1:{port}/'
            self.read('/api/config')
        except Exception:
            self.stop()
            raise RuntimeError('无法启动本地审查服务，请检查解压目录权限与运行文件是否齐全。') from None

    def read(self, route):
        with urllib.request.urlopen(self.url.rstrip('/') + route, timeout=5) as response:
            return json.load(response)

    def busy(self):
        return any(job['status'] in ('queued', 'running') for job in self.read('/api/jobs'))

    def stop(self):
        if self.process.poll() is not None:
            return
        try:
            self.process.stdin.write('stop\n')
            self.process.stdin.flush()
            self.process.wait(timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            if os.name == 'nt':
                subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'],
                               creationflags=NO_WINDOW, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                self.process.kill()
            self.process.wait(timeout=5)
        finally:
            self.process.stdin.close()
            self.process.stdout.close()


def main():
    if '--settings' in sys.argv:
        edit_settings(Path(sys.argv[sys.argv.index('--settings') + 1]))
        return
    with single_instance(HOME_DIR):
        run_window()


def run_window():
    import webview
    from webview.menu import Menu, MenuAction
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    engine = Engine()
    window = None
    guard = ReviewGuard()

    def may_discard_review():
        # Closing runs on the UI thread; evaluating JavaScript here deadlocks WebView2.
        dirty, saving = guard.snapshot()
        if saving:
            window.create_confirmation_dialog('正在保存审批', '请等待审批记录保存完成后继续。')
            return False
        return not dirty or window.create_confirmation_dialog('审批尚未保存', '当前文档的审批决定或替换文字尚未保存，继续将丢弃这些更改。确定继续？')

    def settings():
        if engine.busy():
            window.create_confirmation_dialog('正在审查', '请等待当前任务完成后修改模型设置。')
            return
        if not may_discard_review():
            return
        command = [sys.executable] + ([] if FROZEN else [str(HERE / 'desktop.py')])
        subprocess.run(command + ['--settings', str(engine.config)], creationflags=NO_WINDOW)
        window.load_url(engine.url)

    def open_results():
        os.startfile(str(engine.data))

    def closing():
        if not may_discard_review():
            return False
        try:
            if engine.busy() and not window.create_confirmation_dialog('任务尚未完成', '退出将中断正在审查和排队的任务，已完成结果会保留。确定退出？'):
                return False
        except (OSError, ValueError):
            pass
        engine.stop()

    webview.settings['ALLOW_DOWNLOADS'] = True
    webview.settings['OPEN_EXTERNAL_LINKS_IN_BROWSER'] = False
    menu = [Menu('工具', [MenuAction('模型设置', settings), MenuAction('打开结果目录', open_results)])]
    try:
        window = webview.create_window(NAME, engine.url, width=1280, height=880, min_size=(960, 640), menu=menu, js_api=guard)
        window.events.closing += closing
        webview.start(gui='edgechromium', private_mode=True, icon=str(RESOURCES / 'app-icon.ico'))
    finally:
        engine.stop()


if __name__ == '__main__':
    try:
        main()
    except AlreadyRunning:
        ctypes.windll.user32.MessageBoxW(None, '此目录的审查工具已经运行，请使用已打开的窗口。', NAME, 0x40)
    except Exception:
        ctypes.windll.user32.MessageBoxW(None, '程序无法启动，请确认完整解压，并已安装 Microsoft Edge WebView2 Runtime。', NAME, 0x10)
