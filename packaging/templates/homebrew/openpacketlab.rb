cask "openpacketlab" do
  version "{{VERSION}}"
  sha256 "{{SHA256:OpenPacketLab_{{VERSION}}_universal.dmg}}"

  url "https://github.com/Lin8x/OpenPacketLab/releases/download/v#{version}/OpenPacketLab_#{version}_universal.dmg"
  name "OpenPacketLab"
  desc "Open-source network simulator and teaching lab"
  homepage "https://github.com/Lin8x/OpenPacketLab"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: ">= :catalina"

  app "OpenPacketLab.app"

  zap trash: [
    "~/Library/Application Support/io.github.lin8x.openpacketlab",
    "~/Library/Caches/io.github.lin8x.openpacketlab",
    "~/Library/Saved Application State/io.github.lin8x.openpacketlab.savedState",
    "~/Library/WebKit/io.github.lin8x.openpacketlab",
  ]
end
