/*
 * 只做两件事：
 *  1. 打开/聚焦面板标签页
 *  2. 面板打开期间，动态加一条「仅对该标签页生效」的规则，剥掉 iframe 拦截头
 *
 * 为什么不用静态规则：静态规则对所有页面生效，等于任何网站都能把 ChatGPT
 * 嵌进自己的 iframe 里 —— 那是给点击劫持开口子。这里用 session 规则 +
 * tabIds 条件，作用域收窄到面板这一个标签页，面板关闭立刻撤销。
 */

const RULE_ID = 8801;

// 这些响应头是浏览器在网络层拦 iframe 的依据，必须去掉才能并排嵌入。
const STRIP_HEADERS = [
  { header: 'x-frame-options', operation: 'remove' },
  { header: 'content-security-policy', operation: 'remove' },
  { header: 'content-security-policy-report-only', operation: 'remove' },
];

const TARGET_DOMAINS = [
  'chatgpt.com',
  'chat.openai.com',
  'chat.deepseek.com',
  'claude.ai',
  'gemini.google.com',
  'chat.qwen.ai',
  'yuanbao.tencent.com',
];

const panelUrl = () => chrome.runtime.getURL('panel.html');

async function enableFraming(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: STRIP_HEADERS },
        condition: {
          requestDomains: TARGET_DOMAINS,
          resourceTypes: ['sub_frame'],
          tabIds: [tabId], // 关键：只在面板标签页里放行
        },
      },
    ],
  });
}

async function disableFraming() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] });
}

async function openPanel() {
  const url = panelUrl();
  const existing = await chrome.tabs.query({ url });
  const tab = existing.length
    ? await chrome.tabs.update(existing[0].id, { active: true })
    : await chrome.tabs.create({ url });
  await enableFraming(tab.id);
  return tab;
}

chrome.action.onClicked.addListener(() => {
  openPanel().catch((e) => console.error('[同问] 打开面板失败', e));
});

// 面板关掉或导航离开就撤销规则，不留敞口。
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === RULE_ID);
  if (rule && rule.condition.tabIds?.includes(tabId)) await disableFraming();
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = rules.find((r) => r.id === RULE_ID);
  if (!rule || !rule.condition.tabIds?.includes(tabId)) return;
  if (!info.url.startsWith(panelUrl())) await disableFraming();
});

// 面板向各 iframe 转发指令：iframe 里跑的是 content script，
// 用 frameId 精确投递，避免广播到无关 frame。
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === 'ensure-framing' && sender.tab) {
    enableFraming(sender.tab.id).then(() => respond({ ok: true }));
    return true;
  }
  if (msg?.type === 'relay') {
    chrome.tabs.sendMessage(
      msg.tabId,
      msg.payload,
      { frameId: msg.frameId },
      (res) => respond(res ?? { ok: false, error: chrome.runtime.lastError?.message })
    );
    return true;
  }
  return false;
});
