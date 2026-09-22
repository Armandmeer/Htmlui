Html ui SmartHome KNX Dashboard v2.1.6

GitHub update safety fix.

Update from GitHub now stages the repository first and never replaces the running
application directly. The update helper is launched independently on Windows via
WScript, waits for the old server to release port 3010, installs the staged files,
installs dependencies, starts the new server and checks that it stays reachable.
If the new server crashes or does not come up, the previous application is
restored automatically and restarted.

User state and GitHub credentials are preserved. Updater helper files are protected
from replacement by the GitHub archive.
