/**
 * Configures dependency update targets to preserve TypeScript compatibility while allowing the latest releases for other packages.
 *
 * @type {{target: function(string): ("semver"|"latest")}}
 */
export default {
  target: (name) => (name === "typescript" ? "semver" : "latest"),
};
