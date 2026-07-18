' Starts the PitWall Agent hidden (no console window), and keeps it running.
' Used by the Windows startup registration so the agent runs silently at
' login. This script itself is the supervisor: it waits for the agent
' process to exit, and relaunches it if that exit looks like a crash — a
' persistent process without needing an elevated Windows Service install.
'
' Exit-code convention (see shutdown() and the instance-lock check in
' pitwall-agent/src/index.ts): a clean/intentional exit (tray Quit,
' SIGTERM, or a second copy stepping aside because the lock is already
' held) always exits 0. This script only restarts on a NON-zero exit — a
' genuine crash — so clicking Quit actually quits instead of springing
' back up a few seconds later.
'
' The UDP port and relay target are set explicitly in the process
' environment before launch. dotenv does NOT override existing env vars, so
' this GUARANTEES the agent binds the right port regardless of how its config
' folder resolves in whatever context Windows launches this from — which is
' what previously let it silently fall back to the default 20777.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set env = shell.Environment("Process")
env("UDP_PORT") = "20779"
env("FORWARD_TARGETS") = "127.0.0.1:20777"
agentDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = agentDir

' Capped exponential backoff between crash-restarts, seconds: 2, 5, 15, 30,
' then repeats at 60 — mirrors the bind-retry backoff in udp/listener.ts so
' a persistent crash-loop never spins at full speed.
Dim delays(4)
delays(0) = 2 : delays(1) = 5 : delays(2) = 15 : delays(3) = 30 : delays(4) = 60
attempt = 0
' If the agent ran at least this long before exiting, treat the next crash
' as a fresh one (reset backoff) rather than continuing to ramp up delay
' from an unrelated crash-loop that happened, and recovered from, long ago.
STABLE_RUN_SECONDS = 120

Do
  startedAt = Now
  exitCode = shell.Run("cmd /c ""node_modules\.bin\tsx src\index.ts""", 0, True)
  If exitCode = 0 Then
    Exit Do ' clean/intentional exit — do not restart
  End If

  If DateDiff("s", startedAt, Now) >= STABLE_RUN_SECONDS Then
    attempt = 0
  End If

  idx = attempt
  If idx > UBound(delays) Then idx = UBound(delays)
  WScript.Sleep delays(idx) * 1000
  attempt = attempt + 1
Loop
