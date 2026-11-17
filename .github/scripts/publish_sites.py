"""Publish one indexed snapshot. The server replaces the live snapshot atomically."""
import json
import mimetypes
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(sys.argv[1])
revision = os.environ["GITHUB_SHA"]
origin = os.environ["SITE_URL"]
for required in ("index.html", "404.html", "archive/index.html", "feed.xml", "sitemap.xml"):
    if not (root / required).stat().st_size:
        raise ValueError(f"Empty page: {required}")
(root / "github-revision.txt").write_text(revision + "\n")
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/atom+xml", ".atom")
index = {}
offset = 0
files = sorted(path for path in root.rglob("*") if path.is_file())
for path in files:
    size = path.stat().st_size
    index["/" + path.relative_to(root).as_posix()] = [
        offset, size, mimetypes.guess_type(path)[0] or "application/octet-stream"
    ]
    offset += size
header = json.dumps(index, ensure_ascii=False, separators=(",", ":")).encode()
with tempfile.TemporaryDirectory() as temp:
    pack = Path(temp) / "snapshot"
    with pack.open("wb") as output:
        output.write(header)
        for path in files:
            with path.open("rb") as source:
                shutil.copyfileobj(source, output)
    # Keep the credential out of command arguments and logs.
    auth = 'header = "Authorization: Bearer ' + os.environ["SITES_PUBLISH_KEY"] + '"\n'
    subprocess.run([
        "curl", "--silent", "--show-error", "--fail-with-body", "--retry", "3",
        "--config", "-", "--upload-file", str(pack),
        "-H", f"X-Index-Bytes: {len(header)}", "-H", f"X-Git-Revision: {revision}",
        "-H", "X-Run-Number: " + os.environ["GITHUB_RUN_NUMBER"],
        "-H", "X-Run-Attempt: " + os.environ["GITHUB_RUN_ATTEMPT"],
        origin + "/_publish/blog",
    ], input=auth, text=True, check=True)
# An HTTP success must correspond to the commit readers actually receive.
live = subprocess.check_output([
    "curl", "--fail", "--silent", "--show-error", "--retry", "3", "--max-time", "30",
    origin + "/github-revision.txt?verify=" + revision,
], text=True).strip()
if live != revision:
    raise RuntimeError("The live blog does not report the uploaded commit")
print(f"Published {len(files)} files at {revision}")
