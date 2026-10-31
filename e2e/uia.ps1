# Reads desktop app state through UI Automation, independently of Ottoman, for desktop.e2e.mjs.
#   uia.ps1 calc     -> Calculator display text, e.g. "Display is 40"
#   uia.ps1 notepad  -> text of the Notepad document
#   uia.ps1 windows  -> "process|title" of every top-level window
#   uia.ps1 cleanup  -> answers a Notepad save prompt with "Don't save", then closes Notepad normally
param([string]$what)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$T = [System.Windows.Automation.TreeScope]
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Prop($p, $v) { New-Object System.Windows.Automation.PropertyCondition($p, $v) }
$windows = $A::RootElement.FindAll($T::Children, [System.Windows.Automation.Condition]::TrueCondition)

switch ($what) {
  'calc' {
    $win = $windows | Where-Object { $_.Current.Name -eq 'Calculator' } | Select-Object -First 1
    if ($win) { $win.FindFirst($T::Descendants, (Prop $A::AutomationIdProperty 'CalculatorResults')).Current.Name }
  }
  'notepad' {
    $win = $windows | Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'Notepad' } | Select-Object -First 1
    if ($win) {
      $doc = $win.FindFirst($T::Descendants, (Prop $A::ControlTypeProperty ([System.Windows.Automation.ControlType]::Document)))
      if ($doc) { $doc.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1) }
    }
  }
  'windows' {
    foreach ($w in $windows) { "{0}|{1}" -f (Get-Process -Id $w.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName, $w.Current.Name }
  }
  'cleanup' {
    $win = $windows | Where-Object { (Get-Process -Id $_.Current.ProcessId -ErrorAction SilentlyContinue).ProcessName -eq 'Notepad' } | Select-Object -First 1
    if ($win) {
      $Invoke = [System.Windows.Automation.InvokePattern]::Pattern
      function DontSave {
        $b = $win.FindAll($T::Descendants, (Prop $A::ControlTypeProperty ([System.Windows.Automation.ControlType]::Button))) | Where-Object { $_.Current.Name -match "^Don.t save$" } | Select-Object -First 1
        if ($b) { $b.GetCurrentPattern($Invoke).Invoke(); Start-Sleep -Milliseconds 500 }
      }
      DontSave
      # Close only the test's tab (discarding its edits) so it is not restored with the user's tabs next time.
      $tab = $win.FindAll($T::Descendants, (Prop $A::ControlTypeProperty ([System.Windows.Automation.ControlType]::TabItem))) | Where-Object { $_.Current.Name -like 'ottoman-e2e.txt*' } | Select-Object -First 1
      if ($tab) {
        $tab.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); Start-Sleep -Milliseconds 300
        $close = $tab.FindFirst($T::Descendants, (Prop $A::NameProperty 'Close Tab'))
        if ($close) { $close.GetCurrentPattern($Invoke).Invoke(); Start-Sleep -Milliseconds 500; DontSave }
      }
      $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close()
    }
  }
}
