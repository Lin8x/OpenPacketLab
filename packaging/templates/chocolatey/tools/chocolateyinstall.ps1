$ErrorActionPreference = 'Stop'
Install-ChocolateyPackage -PackageName 'openpacketlab' -FileType 'msi' `
  -Url64bit 'https://github.com/Lin8x/OpenPacketLab/releases/download/v{{VERSION}}/OpenPacketLab_{{VERSION}}_x64_en-US.msi' `
  -Checksum64 '{{SHA256:OpenPacketLab_{{VERSION}}_x64_en-US.msi}}' -ChecksumType64 'sha256' `
  -SilentArgs '/quiet /norestart' -ValidExitCodes @(0, 3010)
