@echo off
rem Rebuilds Smtc.dll. Needs the Windows SDK union metadata (Windows.winmd); adjust the version if yours differs.
set WINMD=C:\Program Files (x86)\Windows Kits\10\UnionMetadata\10.0.22621.0\Windows.winmd
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo -target:library -out:"%~dp0Smtc.dll" -r:System.Runtime.WindowsRuntime.dll -r:System.Runtime.dll -r:System.Drawing.dll "-r:%WINMD%" "%~dp0Smtc.cs"
