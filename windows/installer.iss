; Per-user installer for the Halcyon Windows app (no administrator rights). Built by .github/workflows/windows.yml:
;   iscc /DVersion=1.0.0 /DArch=x64 /DSource=<publish folder> windows\installer.iss
#ifndef Version
  #define Version "1.0.0"
#endif
#ifndef Arch
  #define Arch "x64"
#endif
#ifndef Source
  #define Source "Halcyon\bin\publish"
#endif

[Setup]
AppId={{6E0C4F3B-6A3E-4F5B-9C2C-2B7E1D0A9F41}
AppName=Halcyon for Windows
AppVersion={#Version}
AppPublisher=Halcyon
DefaultDirName={autopf}\Halcyon for Windows
DefaultGroupName=Halcyon
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=Halcyon-Windows-Setup-{#Version}-{#Arch}
OutputDir=out
SetupIconFile=Halcyon\halcyon.ico
UninstallDisplayIcon={app}\Halcyon.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
#if Arch == "arm64"
ArchitecturesAllowed=arm64
ArchitecturesInstallIn64BitMode=arm64
#else
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
#endif

[Files]
Source: "{#Source}\Halcyon.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The AppUserModelID matches Shell.AppId, so toasts and the taskbar button belong to this shortcut.
Name: "{autoprograms}\Halcyon"; Filename: "{app}\Halcyon.exe"; AppUserModelID: "Halcyon.Windows"
Name: "{autodesktop}\Halcyon"; Filename: "{app}\Halcyon.exe"; AppUserModelID: "Halcyon.Windows"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\Halcyon.exe"; Description: "Start Halcyon"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\Halcyon.exe"; Parameters: "--unregister"; Flags: runhidden; RunOnceId: "Unregister"

[Code]
// The app is framework-dependent: it needs the .NET 8 Desktop Runtime (Microsoft.WindowsDesktop.App 8.x).
function HasDesktopRuntime(): Boolean;
var
  F: TFindRec;
  Dir: String;
begin
  Result := False;
  Dir := ExpandConstant('{commonpf64}\dotnet\shared\Microsoft.WindowsDesktop.App\');
  if FindFirst(Dir + '8.*', F) then
  begin
    Result := True;
    FindClose(F);
  end;
end;

function InitializeSetup(): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if not HasDesktopRuntime() then
  begin
    if MsgBox('Halcyon needs the .NET 8 Desktop Runtime, which is not installed on this PC.' + #13#10#13#10 +
      'Open the download page now? Choose ".NET Desktop Runtime 8" for Windows {#Arch}; Halcyon starts once it is installed.',
      mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/8.0', '', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;
