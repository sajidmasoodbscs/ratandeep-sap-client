const NO_CHANGES = {
  operations: [],
};

export function cartTransformRun(input) {
  const operations = input.cart.lines
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

  return {
    operations,
  };
}