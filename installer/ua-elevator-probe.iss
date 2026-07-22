; Inno Setup script for the UniFi Access Elevator Floor Probe.
; Builds a machine-wide installer for the packaged console exe, with an
; optional "add to PATH" task so the tool runs from any terminal.
;
; Build (on Windows, after the exe exists in ..\dist):
;   iscc /DMyAppVersion=0.1.0 installer\ua-elevator-probe.iss
; The release workflow passes the version from the git tag.

#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif

#define MyAppName "UniFi Access Elevator Probe"
#define MyAppPublisher "AJBCloud"
#define MyAppExeName "ua-elevator-probe.exe"
#define MyAppUrl "https://github.com/ajbcloud/accessthrowaway"

[Setup]
AppId={{B7E4B0F2-1C3A-4E5D-9A6B-2F8C1D3E4A5B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppUrl}
AppSupportURL={#MyAppUrl}
DefaultDirName={autopf}\UniFi Access Elevator Probe
DefaultGroupName=UniFi Access Elevator Probe
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
OutputDir=..\dist
OutputBaseFilename=ua-elevator-probe-setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
ChangesEnvironment=yes
UninstallDisplayName={#MyAppName}

[Files]
Source: "..\dist\ua-elevator-probe.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Tasks]
Name: "addtopath"; Description: "Add to PATH so 'ua-elevator-probe' runs from any terminal"; GroupDescription: "Options:"

[Registry]
; Append the install dir to the system PATH only when the task is selected and
; it is not already present. NeedsAddPath guards against duplicate entries.
Root: HKLM; Subkey: "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"; \
  ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; \
  Check: WizardIsTaskSelected('addtopath') and NeedsAddPath(ExpandConstant('{app}'))

[Icons]
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"

[Code]
function NeedsAddPath(Param: string): boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKLM,
    'SYSTEM\CurrentControlSet\Control\Session Manager\Environment',
    'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  { Look for the exact dir bounded by semicolons, case-insensitive. }
  Result := Pos(';' + Lowercase(Param) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;
