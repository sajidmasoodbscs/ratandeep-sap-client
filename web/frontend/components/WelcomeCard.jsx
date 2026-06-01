import { Card, Text, BlockStack } from "@shopify/polaris";

export const WelcomeCard = () => {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingLg">
          Welcome
        </Text>
        <Text as="p" tone="subdued">
          Your Client app is installed and ready to use.
        </Text>
        <Text as="p" tone="subdued">
          Product pricing and cart behavior are managed automatically in the
          background. If you need help, contact your administrator.
        </Text>
      </BlockStack>
    </Card>
  );
};
