; QQ 聊天机器人 · Inno Setup 安装脚本
;
; 由 scripts/build-installer.mjs 调用，两个 /D 参数必须传：
;   /DAppVersion=1.0.6       发布版本号
;   /DSourceDir=...\dist\release   已经打好的绿色目录（不带网关、不带个人数据）
;
; 手动编译：
;   ISCC.exe /DAppVersion=1.0.6 /DSourceDir="dist\release" installer\qq-bot.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
; VersionInfoVersion 只接受 4 段纯数字（1.0.6.fix 这种要由构建脚本折算成 1.0.6.0）。
#ifndef VersionInfoVersion
  #define VersionInfoVersion AppVersion
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\release"
#endif

#define AppName "QQ聊天机器人"
#define AppExe "QQ聊天机器人.exe"
#define AppPublisher "NisssOwO"
#define AppUrl "https://github.com/NisssOwO/qq-robot-talking-FA"

[Setup]
AppId={{D4A2B7E1-6C3F-4F8A-9B21-5E7C8D3A9F10}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={localappdata}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename={#AppName}-{#AppVersion}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
LicenseFile=..\LICENSE
VersionInfoVersion={#VersionInfoVersion}
VersionInfoDescription={#AppName} 安装程序
VersionInfoProductName={#AppName}
VersionInfoCompany={#AppPublisher}

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Messages]
; 英文语言包里挑关键几处换成中文，界面看起来就是中文的
WelcomeLabel1=欢迎安装 [name/ver]
WelcomeLabel2=这将把 [name/ver] 装到你的电脑上。%n%n装完第一次打开会落在「快速开始」，按提示四步走完就能在群里说话。%n%nQQ 网关（SnowLuma）不在这个包里，第一次打开时面板会帮你下载安装。
WizardSelectDir=选择安装位置
SelectDirDesc=把 [name] 装到哪里？
SelectDirLabel3=安装程序会把 [name] 装到下面这个文件夹。
SelectDirBrowseLabel=点「下一步」继续；想换地方就点「浏览」。
WizardSelectTasks=选择附加任务
SelectTasksDesc=还要做哪些事？
SelectTasksLabel2=勾选你想让安装程序顺便做的事，然后点「下一步」。
WizardReady=准备安装
ReadyLabel1=现在开始安装 [name/ver]。
ReadyLabel2a=点「安装」开始。想改什么就点「上一步」回去。
WizardInstalling=正在安装
InstallingLabel=安装程序正在把文件复制到你的电脑上，稍等一下。
FinishedHeadingLabel=[name/ver] 装好了
FinishedLabelNoIcons=[name] 已经装好了。
FinishedLabel=[name] 已经装好了。双击桌面上的图标就能启动。
ClickFinish=点「完成」关闭安装程序。
RunEntryExec=启动 %1
ButtonNext=下一步(&N) >
ButtonBack=< 上一步(&B)
ButtonInstall=安装(&I)
ButtonFinish=完成(&F)
ButtonCancel=取消
ButtonBrowse=浏览(&R)...
ButtonNo=否(&N)
ButtonYes=是(&Y)
ExitSetupTitle=退出安装
ExitSetupMessage=安装还没完成。现在退出的话不会装上 [name]。%n%n要退出吗？
UninstallAppFullTitle=卸载 %1
ConfirmUninstall=确定要卸载 %1 吗？%n%n会自动保留 config.json 和 state 文件夹（群设置、黑话库、聊天记录），想彻底清干净就卸载完手动删掉安装目录。

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："
Name: "startup"; Description: "开机自动启动（不想开机就自启就别勾）"; GroupDescription: "启动选项："; Flags: unchecked

[Files]
; 主体：除了 config.json 和 state 之外全部复制
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "config.json,state\*,state"; Flags: ignoreversion recursesubdirs createallsubdirs
; 配置模板：只有不存在时才写，卸载时不删（用户的密钥和群设置都在里面）
Source: "{#SourceDir}\config.json"; DestDir: "{app}"; Flags: ignoreversion onlyifdoesntexist uninsneveruninstall

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\卸载 {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: startup

[Run]
Filename: "{app}\{#AppExe}"; Description: "现在启动 {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
; 只清掉安装程序自己产生的临时物，其余（config.json、state）留给用户
Type: filesandordirs; Name: "{app}\logs"
Type: dirifempty; Name: "{app}"
