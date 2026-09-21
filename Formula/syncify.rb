class Syncify < Formula
  desc "Sync a Shopify Production store into a Dev store, with strict destination guards"
  homepage "https://github.com/ThanhKhoaIT/syncify"
  url "https://github.com/ThanhKhoaIT/syncify.git", tag: "v0.1.1", revision: "43269e634664e28be36edc670169ff61539fdcee"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "Sync a Shopify Production store", shell_output("#{bin}/syncify --help")
  end
end
