$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
function Banner($t){Write-Host "`n=== $t ===" -ForegroundColor Cyan}
function ValidNode($e){if(-not $e -or -not(Test-Path $e -PathType Leaf)){return $false};try{$v=& $e --version 2>$null;return($LASTEXITCODE -eq 0 -and $v -match '^v\d+')}catch{return $false}}

$nodeExe=$null;$npmCmd=$null
$sn=Get-Command node.exe -ErrorAction SilentlyContinue
$sm=Get-Command npm.cmd -ErrorAction SilentlyContinue
if($sn -and (ValidNode $sn.Source)){
  $nodeExe=$sn.Source;if($sm){$npmCmd=$sm.Source}
  Write-Host "Node.js aanwezig: $(& $nodeExe --version)" -ForegroundColor Green
}else{
  $runtimeDir=Join-Path $env:LOCALAPPDATA 'NuvexAI\runtime'
  $candidate=Join-Path $runtimeDir 'node.exe'
  if(ValidNode $candidate){
    $nodeExe=$candidate;$npmCmd=Join-Path $runtimeDir 'npm.cmd'
    Write-Host "NUVEX Node.js runtime aanwezig: $(& $nodeExe --version)" -ForegroundColor Green
  }else{
    Banner 'Eenmalige installatie van Node.js runtime'
    New-Item -ItemType Directory -Path $runtimeDir -Force|Out-Null
    [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
    $idx=Invoke-RestMethod 'https://nodejs.org/dist/index.json'
    $rel=$idx|Where-Object{$_.lts -and ($_.files -contains 'win-x64-zip')}|Select-Object -First 1
    if(-not $rel){throw 'Geen geschikte Node.js LTS-release gevonden.'}
    $v=$rel.version;$zip=Join-Path $env:TEMP "nuvex-node-$v.zip";$tmp=Join-Path $env:TEMP "nuvex-node-$v"
    Remove-Item $zip -Force -ErrorAction SilentlyContinue;Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest "https://nodejs.org/dist/$v/node-$v-win-x64.zip" -OutFile $zip
    Expand-Archive $zip $tmp -Force
    $s=Get-ChildItem $tmp -Directory|Where-Object{Test-Path(Join-Path $_.FullName 'node.exe')}|Select-Object -First 1
    if(-not $s){throw 'Node.js download kon niet worden uitgepakt.'}
    Remove-Item (Join-Path $runtimeDir '*') -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $s.FullName '*') $runtimeDir -Recurse -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue;Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $nodeExe=Join-Path $runtimeDir 'node.exe';$npmCmd=Join-Path $runtimeDir 'npm.cmd'
    if(-not(ValidNode $nodeExe)){throw 'Node.js runtime kon niet worden gestart.'}
  }
}

Banner 'Nuvex AI 3.0 modules controleren'
$ws=Test-Path(Join-Path $PSScriptRoot 'node_modules\ws\package.json')
$knx=Test-Path(Join-Path $PSScriptRoot 'node_modules\knxultimate\package.json')
$ff=Test-Path(Join-Path $PSScriptRoot 'node_modules\ffmpeg-static\package.json')
if(-not($ws -and $knx -and $ff)){
  Write-Host 'Modules ontbreken; npm install wordt eenmalig uitgevoerd.' -ForegroundColor Yellow
  if(-not(Test-Path $npmCmd -PathType Leaf)){$npmCmd=Join-Path(Split-Path $nodeExe)'npm.cmd'}
  if(-not(Test-Path $npmCmd -PathType Leaf)){throw 'npm.cmd ontbreekt.'}
  & $npmCmd install --omit=dev --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw "npm install mislukt (code $LASTEXITCODE)."}
  foreach($m in @('ws','knxultimate','ffmpeg-static')){if(-not(Test-Path(Join-Path $PSScriptRoot "node_modules\$m\package.json"))){throw "Module '$m' ontbreekt na installatie."}}
}else{Write-Host 'Modules zijn aanwezig.' -ForegroundColor Green}

Banner 'Nuvex AI 3.0 starten'
$env:HTML_UI_PORT='3010'
Write-Host 'Webinterface: http://localhost:3010/' -ForegroundColor Green
Start-Process 'http://localhost:3010/'
& $nodeExe (Join-Path $PSScriptRoot 'server.js')
exit $LASTEXITCODE
