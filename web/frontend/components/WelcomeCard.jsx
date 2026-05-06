import React, { useState, useEffect } from 'react';
import {
  Card,
  Button,
  Banner,
  Spinner,
  Text,
  TextField,
  BlockStack,
  InlineStack,
  Box,
  Layout,
  Badge,
  Divider,
} from '@shopify/polaris';
const DEMO = {
  host: 'redis.example.com',
  port: '6379',
  username: 'default',
  password: '••••••••',
};

export const WelcomeCard = () => {
  const shop = new URLSearchParams(window.location.search).get("shop");

  const [loading, setLoading] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const [error, setError] = useState(null);
  const [redisSaving, setRedisSaving] = useState(false);
  const [redisSaveMessage, setRedisSaveMessage] = useState(null);
  const [shopName, setShopName] = useState(shop || '');
  const [redisHost, setRedisHost] = useState('');
  const [redisPort, setRedisPort] = useState('');
  const [redisPassword, setRedisPassword] = useState('');
  const [redisUsername, setRedisUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [cartTransformGuid, setCartTransformGuid] = useState('');
  const [cartTransformLoading, setCartTransformLoading] = useState(false);
  const [cartTransformMessage, setCartTransformMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/getsettings?shop=${shop}`);
        const json = await response.json();
        if (cancelled) return;
        const row = json?.data?.[0];
        const safe = (v) => (v == null ? '' : String(v));
        if (row?.shop_name) setShopName(safe(row.shop_name));
        setRedisHost(row ? safe(row.redis_host) : '');
        setRedisPort(row ? safe(row.redis_port) : '');
        setRedisPassword(row ? safe(row.redis_password) : '');
        setRedisUsername(row ? safe(row.redis_username) : '');
      } catch (_) {
        if (!cancelled) {
          setRedisHost('');
          setRedisPort('');
          setRedisPassword('');
          setRedisUsername('');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [shop]);

  const handleSyncProducts = async () => {
    setLoading(true);
    setError(null);
    setSyncResult(null);

    try {
      const response = await fetch(`/api/sync-products?shop=${shop}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data = await response.json();

      if (response.ok) {
        setSyncResult(data);
      } else {
        setError(data.message || 'Failed to sync products');
      }
    } catch (err) {
      setError(err.message || 'An error occurred while syncing products');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveRedis = async () => {
    setRedisSaving(true);
    setRedisSaveMessage(null);
    try {
      const response = await fetch(`/api/redis-settings?shop=${shop}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: redisHost || null,
          port: redisPort || null,
          password: redisPassword || null,
          username: redisUsername || null,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        setRedisSaveMessage({ success: true, text: data.message || 'Settings saved successfully.' });
      } else {
        setRedisSaveMessage({ success: false, text: data.error || data.message || 'Failed to save settings.' });
      }
    } catch (err) {
      setRedisSaveMessage({ success: false, text: err.message || 'Failed to save settings.' });
    } finally {
      setRedisSaving(false);
    }
  };

  const handleActivateCartTransformer = async () => {
    setCartTransformLoading(true);
    setCartTransformMessage(null);
    try {
      const response = await fetch(`/api/carttransformer?shop=${shop}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guid: cartTransformGuid || null }),
      });
      const data = await response.json();
      if (response.ok) {
        setCartTransformMessage({
          success: true,
          text: 'Cart transformer call completed successfully.',
        });
      } else {
        setCartTransformMessage({
          success: false,
          text: data?.error || data?.message || 'Failed to call cart transformer.',
        });
      }
    } catch (err) {
      setCartTransformMessage({
        success: false,
        text: err.message || 'Failed to call cart transformer.',
      });
    } finally {
      setCartTransformLoading(false);
    }
  };

  return (
    <BlockStack gap="500">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="500">
              <BlockStack gap="200">
                <InlineStack align="space-between">
                    <BlockStack gap="100">
                        <Text as="h2" variant="headingLg">Manual Synchronization</Text>
                        <Text as="p" tone="subdued">
                            Instantly update your product prices by syncing with SAP data source.
                        </Text>
                    </BlockStack>
                </InlineStack>
              </BlockStack>

              <Divider />

              <InlineStack gap="400" align="start">
                <Button
                  variant="primary"
                  size="large"
                  onClick={handleSyncProducts}
                  loading={loading}
                  disabled={loading}
                >
                  {loading ? 'Syncing Products...' : 'Start Manual Sync'}
                </Button>
                
                {loading && (
                    <Box paddingBlockStart="200">
                        <InlineStack gap="200">
                            <Spinner size="small" />
                            <Text tone="subdued">Connecting to SAP & Redis...</Text>
                        </InlineStack>
                    </Box>
                )}
              </InlineStack>

              {error && (
                <Banner tone="critical" onDismiss={() => setError(null)}>
                  <p>{error}</p>
                </Banner>
              )}

              {syncResult && !loading && (
                <Banner tone="success" onDismiss={() => setSyncResult(null)}>
                  <BlockStack gap="400">
                    <InlineStack gap="200">
                        <Text as="p" fontWeight="bold">Sync Task Completed</Text>
                    </InlineStack>
                    
                    <InlineStack gap="300">
                        <Badge tone="info">Total Products: {syncResult.totalProducts}</Badge>
                        <Badge tone="info">Total Variants: {syncResult.totalVariants}</Badge>
                        <Badge tone="info-keppel">SKUs: {syncResult.uniqueSKUs}</Badge>
                    </InlineStack>

                    <Box 
                      padding="400" 
                      background="bg-surface-secondary" 
                      borderRadius="200"
                    >
                        <InlineStack gap="800">
                            <BlockStack gap="100">
                                <Text as="p" variant="bodySm" tone="subdued">Variants Inserted</Text>
                                <Text as="p" variant="headingMd" fontWeight="bold" tone="success">{syncResult.inserted}</Text>
                            </BlockStack>
                            <BlockStack gap="100">
                                <Text as="p" variant="bodySm" tone="subdued">Variants Skipped</Text>
                                <Text as="p" variant="headingMd" fontWeight="bold">{syncResult.skipped}</Text>
                            </BlockStack>
                        </InlineStack>
                    </Box>
                  </BlockStack>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.AnnotatedSection
          title="Redis Configuration"
          description={
            <BlockStack gap="400">
              <Text as="p" tone="subdued">
                Manage your secure Redis connection strings. These credentials are used to power the real-time pricing engine for your shop.
              </Text>
              {shopName && (
                <Box paddingBlockStart="200">
                    <Badge tone="success-strong">Connection Active: {shopName}</Badge>
                </Box>
              )}
            </BlockStack>
          }
        >
          <Card>
            <BlockStack gap="500">
              <InlineStack gap="400" align="fill">
                <Box style={{ flex: 1 }}>
                    <TextField
                        label="Host / Endpoint"
                        value={redisHost}
                        onChange={setRedisHost}
                        placeholder={DEMO.host}
                        autoComplete="off"
                    />
                </Box>
                <Box style={{ width: '100px' }}>
                    <TextField
                        label="Port"
                        value={redisPort}
                        onChange={setRedisPort}
                        type="number"
                        placeholder={DEMO.port}
                        autoComplete="off"
                    />
                </Box>
              </InlineStack>

              <TextField
                label="Username"
                value={redisUsername}
                onChange={setRedisUsername}
                placeholder={DEMO.username}
                autoComplete="off"
              />

              <TextField
                label="Password"
                value={redisPassword}
                onChange={setRedisPassword}
                type={showPassword ? 'text' : 'password'}
                placeholder="••••••••"
                autoComplete="off"
                suffix={
                    <Button 
                      variant="plain" 
                      onClick={() => setShowPassword(!showPassword)}
                    />
                }
              />

              <BlockStack gap="200">
                <InlineStack gap="100" align="center">
                    <Text as="p" fontWeight="semibold">Application Connection URL</Text>
                </InlineStack>
                
                <div style={{
                  padding: '16px',
                  background: 'var(--p-color-bg-surface-secondary)',
                  borderRadius: 'var(--p-border-radius-200)',
                  fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace',
                  fontSize: '12px',
                  wordBreak: 'break-all',
                  border: '1px solid var(--p-color-border-subdued)',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.05)'
                }}>
                  <span style={{ color: 'var(--p-color-text-info)' }}>redis://</span>
                  <span style={{ borderBottom: '1px dashed var(--p-color-text-subdued)' }}>{redisUsername || DEMO.username}</span>
                  <span style={{ color: 'var(--p-color-text-info)' }}>:</span>
                  <span style={{ borderBottom: '1px dashed var(--p-color-text-subdued)' }}>{redisPassword ? '••••••••' : DEMO.password}</span>
                  <span style={{ color: 'var(--p-color-text-info)' }}>@</span>
                  <span style={{ borderBottom: '1px dashed var(--p-color-text-subdued)' }}>{redisHost || DEMO.host}</span>
                  <span style={{ color: 'var(--p-color-text-info)' }}>:</span>
                  <span style={{ borderBottom: '1px dashed var(--p-color-text-subdued)' }}>{redisPort || DEMO.port}</span>
                </div>
                <InlineStack gap="100" align="center">
                    <Text variant="bodySm" tone="subdued">This URL is generated dynamically for preview purposes.</Text>
                </InlineStack>
              </BlockStack>

              <Divider />

              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleSaveRedis}
                  loading={redisSaving}
                  disabled={redisSaving}
                >
                  {redisSaving ? 'Saving...' : 'Save Configuration'}
                </Button>
              </InlineStack>

              {redisSaveMessage && (
                <Banner
                  tone={redisSaveMessage.success ? 'success' : 'critical'}
                  onDismiss={() => setRedisSaveMessage(null)}
                >
                  <p>{redisSaveMessage.text}</p>
                </Banner>
              )}

              <Divider />

              <TextField
                label="Cart Transformer GUID"
                value={cartTransformGuid}
                onChange={setCartTransformGuid}
                placeholder="Enter GUID / function handle"
                autoComplete="off"
              />

              <InlineStack align="start">
                <Button
                  variant="secondary"
                  onClick={handleActivateCartTransformer}
                  loading={cartTransformLoading}
                  disabled={cartTransformLoading}
                >
                  Hello World
                </Button>
              </InlineStack>

              {cartTransformMessage && (
                <Banner
                  tone={cartTransformMessage.success ? 'success' : 'critical'}
                  onDismiss={() => setCartTransformMessage(null)}
                >
                  <p>{cartTransformMessage.text}</p>
                </Banner>
              )}
            </BlockStack>

          </Card>
        </Layout.AnnotatedSection>
      </Layout>
    </BlockStack>
  );
};
