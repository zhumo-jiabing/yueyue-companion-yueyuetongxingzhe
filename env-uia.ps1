# 玥玥 · 桌面语义（L2）——只读窗口与控件类型，不读文字、不截图
# 由 main.js 的 env:uia 调用；输出一行 JSON。任何异常都输出 {"ok":false}。
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
'@
Add-Type -AssemblyName UIAutomationClient

$h = [W.U]::GetForegroundWindow()
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false}'; exit 0 }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
$foc = [System.Windows.Automation.AutomationElement]::FocusedElement

function Get-SafeName($el) {
    if ($null -eq $el) { return '' }
    $ct = ''
    try { $ct = [string]$el.Current.ControlType.ProgrammaticName } catch { return '' }
    # 编辑框/文档/文本一律不取 Name，避免把正文、网址、密码带出去。
    if ($ct -match 'Edit|Document|Text') { return '' }
    $n = ''
    try { $n = [string]$el.Current.Name } catch { return '' }
    if ($n.Length -gt 80) { $n = $n.Substring(0, 80) }
    return $n
}

$winName = Get-SafeName $root
$ct = ''
$name = ''
$isPassword = $false
$isEditable = $false
if ($null -ne $foc) {
    try { $ct = [string]$foc.Current.ControlType.ProgrammaticName } catch { $ct = '' }
    $name = Get-SafeName $foc
    try { $isPassword = [bool]$foc.Current.IsPassword } catch { $isPassword = $false }
    if ($ct -match 'Edit') { $isEditable = $true }
}

$proc = ''
try {
    $pid2 = [int]$root.Current.ProcessId
    $proc = [string](Get-Process -Id $pid2).ProcessName
} catch { $proc = '' }

$obj = [ordered]@{
    ok = $true
    window = $winName
    process = $proc
    control = $ct
    name = $name
    password = $isPassword
    editable = $isEditable
}
$obj | ConvertTo-Json -Compress
