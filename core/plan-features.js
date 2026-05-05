const PLAN_FEATURES = Object.freeze({
  LITE: Object.freeze({
    enableAI: false,
    enableTelegram: true,
    enableSentiment: false,
    captureLeadOnly: true
  }),
  BASIC: Object.freeze({
    enableAI: false,
    enableTelegram: true,
    enableSentiment: false,
    captureLeadOnly: false
  }),
  PRO: Object.freeze({
    enableAI: true,
    enableTelegram: true,
    enableSentiment: false,
    captureLeadOnly: false
  }),
  ENTERPRISE: Object.freeze({
    enableAI: true,
    enableTelegram: true,
    enableSentiment: true,
    captureLeadOnly: false
  })
});

function getPlanFeatures(plan) {
  return PLAN_FEATURES[plan] || PLAN_FEATURES.BASIC;
}

module.exports = {
  PLAN_FEATURES,
  getPlanFeatures
};
