export function getAppConfig() {
  return window.BSH_APP_CONFIG || {
    apiBaseUrl: '/api',
    productImageBucket: 'product-images'
  };
}
