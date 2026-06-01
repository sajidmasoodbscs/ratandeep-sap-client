const NO_CHANGES = {
  operations: [],
};

export function cartTransformRun(input) {
  const lines = input.cart?.lines || [];
  console.log("[cart-transformer] run — line count:", lines.length);
  lines.forEach((line, i) => {
    console.log(
      `[cart-transformer] line ${i} id=${line.id} sap_price=${line.attribute?.value ?? "(missing)"}`
    );
  });

  const operations = lines
    .map((line) => {
      const sapPrice = line.attribute?.value;
      if (sapPrice) {
        const amount = parseFloat(sapPrice);
        if (!isNaN(amount)) {
          return {
            lineUpdate: {
              cartLineId: line.id,
              price: {
                adjustment: {
                  fixedPricePerUnit: {
                    amount: amount,
                  },
                },
              },
            },
          };
        }
      }
      return null;
    })
    .filter(Boolean);

  console.log("[cart-transformer] price operations:", operations.length);
  return {
    operations,
  };
}