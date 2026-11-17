"""Check the public release version without downloading or executing programs."""
import json
import re
import urllib.request
from urllib.parse import urlparse

from release_info import VERSION, REPOSITORY


def version_tuple(value):
    match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', value or '')
    return tuple(map(int, match.groups())) if match else None


def release_update(release, current=VERSION):
    latest = version_tuple(release.get('tag_name'))
    installed = version_tuple(current)
    url = release.get('html_url', '')
    parsed = urlparse(url)
    available = bool(latest and installed and latest > installed and not release.get('draft') and not release.get('prerelease')
                     and parsed.scheme == 'https' and parsed.netloc == 'github.com'
                     and parsed.path == f'/{REPOSITORY}/releases/tag/{release["tag_name"]}' and not parsed.query and not parsed.fragment)
    return {'available': available, 'current': current, **({'version': release['tag_name'], 'url': url} if available else {})}


def check_updates():
    try:
        request = urllib.request.Request(f'https://api.github.com/repos/{REPOSITORY}/releases/latest',
                                         headers={'User-Agent': 'ResearchDocumentReview/' + VERSION, 'Accept': 'application/vnd.github+json'})
        with urllib.request.urlopen(request, timeout=6) as response:
            payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            return {'available': False, 'current': VERSION}
        return release_update(json.loads(payload))
    except (OSError, ValueError, TypeError, AttributeError):
        return {'available': False, 'current': VERSION}
