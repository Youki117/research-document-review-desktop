"""Freeze the desktop shell with bundled Node and the existing review package."""
import json
import filecmp
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile
from release_info import VERSION

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
NAME = '研发文档审查-下沙'


def prepare_stage():
    stage = HERE / 'stage'
    stage.mkdir(exist_ok=True)
    source = HERE / 'engine' if (HERE / 'engine').exists() else ROOT / 'independent-tools/xiasha-serial-20261116/packages/research-document-xiasha'
    tool = stage / 'tool'
    shutil.copytree(source, tool, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns('data', '__pycache__', '*.pyc', '模型配置.json', 'start.cmd'))
    shutil.copytree(HERE / 'public', tool / 'web/public', dirs_exist_ok=True)
    shutil.copyfile(HERE / 'app-icon.png', tool / 'web/public/icon.png')
    shutil.copyfile(HERE / 'desktop-host.mjs', stage / 'desktop-host.mjs')
    node = Path(shutil.which('node'))
    if not (stage / 'node.exe').exists() or not filecmp.cmp(node, stage / 'node.exe', shallow=False):
        shutil.copyfile(node, stage / 'node.exe')
    return stage


def build():
    stage = prepare_stage()
    command = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--windowed', '--noupx',
               '--name', NAME, '--icon', str(HERE / 'app-icon.ico'), '--distpath', str(HERE / f'dist/v{VERSION}'), '--workpath', str(HERE / 'build'),
               '--specpath', str(HERE), '--add-data', str(stage / 'tool') + ';tool',
               '--add-data', str(stage / 'desktop-host.mjs') + ';.', '--add-data', str(HERE / 'app-icon.ico') + ';.', '--add-binary', str(stage / 'node.exe') + ';.',
               '--exclude-module', 'torch', '--exclude-module', 'matplotlib', '--exclude-module', 'scipy',
               '--exclude-module', 'pandas', '--exclude-module', 'numpy', '--exclude-module', 'IPython',
               str(HERE / 'desktop.py')]
    subprocess.run(command, cwd=HERE, check=True)
    dest = HERE / f'dist/v{VERSION}' / NAME
    (dest / '模型配置.json').write_text(json.dumps({'文本模型': {'API地址': '', '模型名称': '', 'API密钥': ''}}, ensure_ascii=False, indent=2), encoding='utf-8')
    shutil.copyfile(HERE / 'README.md', dest / '使用说明.md')
    archive_path = HERE / f'dist/研发文档审查-下沙-v{VERSION}.zip'
    with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in dest.rglob('*'):
            if path.is_file() and 'data' not in path.relative_to(dest).parts:
                archive.write(path, Path(NAME) / path.relative_to(dest))
    print(dest / (NAME + '.exe'))
    print(archive_path)


if __name__ == '__main__':
    build()
