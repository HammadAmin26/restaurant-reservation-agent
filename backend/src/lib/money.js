// Money is stored as integer paisa (PKR 1 = 100 paisa).
// These helpers turn it into text people can read.

// Whole rupees show no decimals; amounts with paisa always show two
const wholePkr = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const fractionalPkr = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// 249900 -> "PKR 2,499", 124950 -> "PKR 1,249.50"
function formatPkr(paisa) {
  if (!Number.isInteger(paisa)) {
    throw new TypeError(`Expected integer paisa, got ${paisa}`);
  }

  const formatter = paisa % 100 === 0 ? wholePkr : fractionalPkr;
  return `PKR ${formatter.format(paisa / 100)}`;
}

module.exports = { formatPkr };
