@echo off
rem Plan 04-02: launch PowerShell under classic conhost so SW_HIDE works.
rem Under Windows Terminal's ConPTY, GetConsoleWindow returns a message-only
rem HWND and SW_HIDE is a no-op.
rem Reference: .planning/phases/04-tray-startup-ux/04-RESEARCH.md Q2 + Pitfall 1.
rem
rem This file is pure ASCII on purpose: cmd.exe parses .bat in the OEM codepage
rem (DBCS on JP/CN/KR/RU Windows), so any UTF-8 multibyte here corrupts the
rem 'rem' line parser and makes cmd try to execute the garbled tail.
rem
rem 'start ""' launches conhost in its own window and lets this launcher cmd
rem exit, so only one console is visible to the user.
start "" conhost.exe powershell -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
