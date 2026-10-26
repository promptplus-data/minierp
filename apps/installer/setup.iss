; SCG Shop ERP – on-premise Windows installer (Inno Setup 6.3+)
;
; One setup.exe, two roles chosen on the "Machine role" page:
;   Main machine   : Node runtime + dist-onprem server bundle + web build + PostgreSQL 16,
;                    WinSW services, LAN-only firewall rules, self-signed TLS cert,
;                    migrations, nightly backup task. Optionally the client app too.
;   Client machine : only the Tauri client app (its own NSIS setup, run silently).
;
; Build (Windows; CI does this in .github/workflows/release-windows.yml):
;   iscc /DAppVersion=1.2.3 apps\installer\setup.iss
; Expects the staged payload in apps\installer\build\ (see docs/DEPLOY.md):
;   build\node\  build\pgsql\  build\winsw\WinSW-x64.exe  build\server\  build\web\
;   build\client\SCG-Shop-ERP-Client-Setup.exe
;
; STATUS: never compiled or run here (Linux container). Untested on Windows.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#define AppName "SCG Shop ERP"
#define HttpsPort "8443"

[Setup]
AppId={{6B0C1E52-3C1F-4C55-9F0E-5C9B2C7E8A11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=SCG
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=Output
OutputBaseFilename=SCG-Shop-ERP-Setup
SetupIconFile=..\desktop\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\scgerp.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "installclient"; Description: "Also install the client app on this machine (needed to print receipts here)"; Check: IsMainRole

[Files]
; ---- main machine ----
Source: "build\node\*";   DestDir: "{app}\node";   Flags: recursesubdirs createallsubdirs ignoreversion; Check: IsMainRole
Source: "build\server\*"; DestDir: "{app}\server"; Flags: recursesubdirs createallsubdirs ignoreversion; Check: IsMainRole
Source: "build\web\*";    DestDir: "{app}\web";    Flags: recursesubdirs createallsubdirs ignoreversion; Check: IsMainRole
Source: "build\pgsql\*";  DestDir: "{app}\pgsql";  Flags: recursesubdirs createallsubdirs ignoreversion; Check: IsMainRole
Source: "build\winsw\WinSW-x64.exe"; DestDir: "{app}\winsw"; Flags: ignoreversion; Check: IsMainRole
Source: "winsw\*.xml.template";      DestDir: "{app}\winsw"; Flags: ignoreversion; Check: IsMainRole
Source: "scripts\install-main.ps1";   DestDir: "{app}\scripts"; Flags: ignoreversion; Check: IsMainRole
Source: "scripts\uninstall-main.ps1"; DestDir: "{app}\scripts"; Flags: ignoreversion; Check: IsMainRole
Source: "scripts\backup.ps1";         DestDir: "{app}\scripts"; Flags: ignoreversion; Check: IsMainRole
Source: "..\desktop\src-tauri\icons\icon.ico"; DestDir: "{app}"; DestName: "scgerp.ico"; Flags: ignoreversion
; ---- client app (both roles, when wanted) ----
Source: "build\client\SCG-Shop-ERP-Client-Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Check: NeedsClientApp

[Icons]
Name: "{autodesktop}\{#AppName} (this machine)"; Filename: "https://localhost:{#HttpsPort}/"; IconFilename: "{app}\scgerp.ico"; Check: IsMainRoleWithoutClient
Name: "{group}\Back up database now"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\backup.ps1"" -Reason manual"; IconFilename: "{app}\scgerp.ico"; Check: IsMainRole

[Run]
Filename: "{tmp}\SCG-Shop-ERP-Client-Setup.exe"; Parameters: "/S"; StatusMsg: "Installing the client app..."; Flags: waituntilterminated; Check: NeedsClientApp

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\uninstall-main.ps1"" -AppDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveServices"; Check: HasMainScripts

[UninstallDelete]
Type: filesandordirs; Name: "{app}\services"

[Code]
var
  RolePage: TInputOptionWizardPage;

function IsMainRole: Boolean;
begin
  Result := RolePage.Values[0];
end;

// Usable during uninstall too (RolePage does not exist then).
function HasMainScripts: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\scripts\uninstall-main.ps1'));
end;

function NeedsClientApp: Boolean;
begin
  Result := (not IsMainRole) or WizardIsTaskSelected('installclient');
end;

function IsMainRoleWithoutClient: Boolean;
begin
  Result := IsMainRole and not WizardIsTaskSelected('installclient');
end;

procedure InitializeWizard;
begin
  RolePage := CreateInputOptionPage(wpWelcome,
    'Machine role', 'Which machine is this?',
    'Install the MAIN machine once per shop: it keeps the database and serves every other device on the LAN. ' +
    'Cash registers and office PCs are CLIENT machines.',
    True, False);
  RolePage.Add('Main machine (server + database)');
  RolePage.Add('Client machine (connects to the main machine)');
  RolePage.Values[0] := GetPreviousData('Role', 'main') = 'main';
  RolePage.Values[1] := not RolePage.Values[0];
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
var
  Role: String;
begin
  if IsMainRole then Role := 'main' else Role := 'client';
  SetPreviousData(PreviousDataKey, 'Role', Role);
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // A client machine has nothing to install under {app} worth choosing a folder for.
  Result := (PageID = wpSelectDir) and not IsMainRole;
end;

function DataDir: String;
begin
  Result := ExpandConstant('{commonappdata}\SCG Shop ERP');
end;

function RunPowerShell(const Script, Args: String; var ResultCode: Integer): Boolean;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" ' + Args,
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// Upgrade path: back up the database and stop the services before files are replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Backup: String;
begin
  Result := '';
  if not IsMainRole then exit;
  Backup := ExpandConstant('{app}\scripts\backup.ps1');
  if FileExists(Backup) then
  begin
    WizardForm.PreparingLabel.Caption := 'Backing up the database before upgrading...';
    if ((not RunPowerShell(Backup, '-Reason pre-upgrade', Code)) or (Code <> 0)) and
       (SuppressibleMsgBox('The pre-upgrade database backup failed (is the database service running?).' + #13#10 +
          'Continue the upgrade WITHOUT a fresh backup?', mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDNO) then
    begin
      Result := 'Setup stopped before changing anything because the pre-upgrade backup failed. ' +
        'Logs: ' + DataDir + '\logs';
      exit;
    end;
  end;
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop scgerp-server', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\sc.exe'), 'stop scgerp-postgres', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(3000);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Code: Integer;
begin
  if (CurStep <> ssPostInstall) or not IsMainRole then exit;
  WizardForm.StatusLabel.Caption := 'Configuring database, certificate, services and firewall...';
  if (not RunPowerShell(ExpandConstant('{app}\scripts\install-main.ps1'),
        '-AppDir "' + ExpandConstant('{app}') + '" -DataDir "' + DataDir + '" -HttpsPort {#HttpsPort}', Code))
     or (Code <> 0) then
    MsgBox('Configuring the main machine failed (exit code ' + IntToStr(Code) + ').' + #13#10 +
      'Details: ' + DataDir + '\logs\install-main.log' + #13#10 +
      'Fix the problem and run this setup again; it is safe to re-run.', mbError, MB_OK);
end;
