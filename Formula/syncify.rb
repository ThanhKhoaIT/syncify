class Syncify < Formula
  desc "Sync a Shopify Production store into a Dev store, with strict destination guards"
  homepage "https://github.com/ThanhKhoaIT/syncify"
  url "https://github.com/ThanhKhoaIT/syncify.git", tag: "v0.1.10", revision: "fa1c88b26b28c658e3477d9b1ed0024f3d52084e"
  license "MIT"

  depends_on "node"

  def install
    # Local install (incl. devDependencies) + build, since the global
    # install below runs with --ignore-scripts and only installs
    # "dependencies" — it can't run `tsc` itself.
    system "npm", "install"
    system "npm", "run", "build"
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "Sync a Shopify Production store", shell_output("#{bin}/syncify --help")
  end
end
