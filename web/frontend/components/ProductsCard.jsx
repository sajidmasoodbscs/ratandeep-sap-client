import { useState } from "react";
import { Card, Text, BlockStack, InlineStack, Button, Box } from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "react-query";

export function ProductsCard() {
  const shopify = useAppBridge();
  const { t } = useTranslation();
  const [isPopulating, setIsPopulating] = useState(false);
  const productsCount = 5;

  const shop = new URLSearchParams(window.location.search).get("shop");

  const {
    data,
    refetch: refetchProductCount,
    isLoading: isLoadingCount,
  } = useQuery({
    queryKey: ["productCount"],
    queryFn: async () => {
      const response = await fetch(`/api/products/count?shop=${shop}`);
      return await response.json();
    },
    refetchOnWindowFocus: false,
  });

  const setPopulating = (flag) => {
    shopify.loading(flag);
    setIsPopulating(flag);
  };

  const handlePopulate = async () => {
    setPopulating(true);
    const response = await fetch(`/api/products?shop=${shop}`, { method: "POST" });

    if (response.ok) {
      await refetchProductCount();

      shopify.toast.show(
        t("ProductsCard.productsCreatedToast", { count: productsCount })
      );
    } else {
      shopify.toast.show(t("ProductsCard.errorCreatingProductsToast"), {
        isError: true,
      });
    }

    setPopulating(false);
  };

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">
            {t("ProductsCard.title")}
          </Text>
          <Text as="p" tone="subdued">
            {t("ProductsCard.description")}
          </Text>
        </BlockStack>

        <Box paddingBlockStart="200" paddingBlockEnd="200">
          <BlockStack gap="100">
            <Text as="h3" variant="headingSm">
              {t("ProductsCard.totalProductsHeading")}
            </Text>
            <Text variant="bodyLg" as="p" fontWeight="bold">
              {isLoadingCount ? "-" : data?.count}
            </Text>
          </BlockStack>
        </Box>

        <InlineStack align="end">
          <Button
            variant="primary"
            onClick={handlePopulate}
            loading={isPopulating}
          >
            {t("ProductsCard.populateProductsButton", {
              count: productsCount,
            })}
          </Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}
