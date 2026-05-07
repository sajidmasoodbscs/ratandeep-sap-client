// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  /** @type {Array<import("../generated/api").Operation>} */
  const operations = [];
  const lines = /** @type {any[]} */ (input.cart.lines);

  lines.forEach((line) => {
      const sapPrice = line.attribute?.value;
      if (!sapPrice) return;
      const amount = parseFloat(sapPrice);
      if (Number.isNaN(amount)) return;

      operations.push({
        lineUpdate: {
          cartLineId: line.id,
          price: {
            adjustment: {
              fixedPricePerUnit: {
                amount,
              },
            },
          },
        },
      });
    });

  return operations.length > 0 ? { operations } : NO_CHANGES;
};