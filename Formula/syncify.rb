class Syncify < Formula
  desc "Sync a Shopify Production store into a Dev store, with strict destination guards"
  homepage "https://github.com/ThanhKhoaIT/syncify"
  url "https://github.com/ThanhKhoaIT/syncify.git", tag: "v0.1.26", revision: "35b1995ee694f4aa938ffb56b83f1844aa8c6ad3"
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
