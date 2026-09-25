# Pi compatibility monitoring

Run on Linux/WSL with Node 24 and npm:

    node compat/run.mjs minimum
    node compat/run.mjs latest

The runner resolves coding-agent from npm, copies the current src/test/compat into
a temporary root, and installs only the selected Pi runtime there. The provider's
pi-ai peer resolves to the target coding-agent's actual pi-ai dependency, including
its published shrinkwrap. No project npm install, lockfile rewrite, or production
configuration change is performed. Network is needed for npm installation only;
generation uses controlled child processes and offline model runtime settings.

Eleven contracts select nineteen real-Pi tests: seventeen existing integration
cases and two resource-loading checks. Exact expected pass counts prevent renamed or missing
tests from becoming green. Tests may inspect Pi internals to detect semantic
changes; production source stays unchanged. Skills use Pi's real read-tool-enabled
catalog construction, but assert no Pi tool execution.

Reports/logs go to a temporary directory printed on exit, or PI_COMPAT_REPORT_DIR.
Each lane reports requested/resolved Pi, pi-ai, Node, and individual contracts.
Setup failures leave contracts untested; minimum failures are red, latest alerts
yellow. Both fail the monitoring workflow, never alter release workflow gates.

The independent workflow runs weekly and on workflow_dispatch. Routine successful
runs stay in Actions; keep tracking issue #1 open. Update it for meaningful changes,
never invent a passing state from local-only results.
