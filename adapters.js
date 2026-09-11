/*
 * 站点适配器 + DOM 操作。与 broadcast-prompt.user.js 里的逻辑同源，
 * 站点改版时只改这一个文件。既被 content script 直接加载，
 * 也被 test/ 下的 Node 测试以文本方式求值。
 */
(function (root) {
  'use strict';

  const ADAPTERS = [
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      url: 'https://chatgpt.com/?model=auto',
      host: /(^|\.)(chatgpt\.com|chat\.openai\.com)$/,
      input: (d) =>
        d.querySelector('div#prompt-textarea[contenteditable="true"]') ||
        d.querySelector('#prompt-textarea') ||
        d.querySelector('main div[contenteditable="true"]'),
      sendBtn: (d) =>
        d.querySelector('button[data-testid="send-button"]') ||
        d.querySelector('button[aria-label*="Send" i]'),
      answers: (d) => d.querySelectorAll('[data-message-author-role="assistant"]'),
      inputSettleMs: 150,

      // 附件支持。fileInput 找隐藏的 <input type=file>；uploadedChips 用来判断
      // 站点是否已经把文件收下（缩略图/文件条出现），这些类名容易随改版失效，
      // 所以给多个候选，任一命中即算数，且等待逻辑超时也放行。
      supportsFiles: true,
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[data-testid*="attachment"], [class*="attachment"], ' +
          'form img[alt]:not([alt=""]), [class*="thumbnail"], ' +
          'img[src^="blob:"], img[src^="data:"], [class*="file-preview"]'
        ),
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      url: 'https://chat.deepseek.com/',
      host: /(^|\.)chat\.deepseek\.com$/,
      // 发送键是 div[role=button]，既没有 testid 也不写 disabled/aria-disabled，
      // 读不出可用状态，所以标记 sendStateUnreliable；提交阶段另做真实成功确认。
      sendStateUnreliable: true,
      // 图片进入预览不代表上传处理已经完成；过早 click 会被静默忽略。
      // 必须观察输入框清空，未清空就在有限时间内重试。
      verifySubmit: true,
      submitVerifyMs: 10000,
      input: (d) => {
        exitDeepSeekSelectMode(d);
        return d.querySelector('#chat-input') || d.querySelector('textarea');
      },
      sendBtn: (d) => {
        exitDeepSeekSelectMode(d);

        // 1. 优先语义匹配发送按钮，且必须通过黑名单过滤（杜绝误点分享、取消等）
        const explicitBtn =
          d.querySelector('button[data-testid*="send" i]') ||
          d.querySelector('button[aria-label*="发送" i]') ||
          d.querySelector('button[aria-label*="Send" i]') ||
          d.querySelector('[role="button"][aria-label*="发送" i]') ||
          d.querySelector('[role="button"][aria-label*="Send" i]') ||
          d.querySelector('div[class*="send"][role="button"]');
        if (explicitBtn && !isForbiddenSendButton(explicitBtn) && visible(explicitBtn)) {
          return explicitBtn;
        }

        // 2. 严格限制在输入框近邻容器内，绝不落到全局 document，防止误触聊天气泡里的分享按钮
        const input = d.querySelector('#chat-input') || d.querySelector('textarea');
        if (input) {
          const container =
            input.closest('form') ||
            input.closest('[class*="chat-input"]') ||
            input.closest('[class*="input-box"]') ||
            input.closest('[class*="chat-box"]') ||
            input.parentElement?.parentElement?.parentElement ||
            input.parentElement?.parentElement;
          if (container) {
            const safeBtns = Array.from(
              container.querySelectorAll('button, [role="button"], div[tabindex="0"]')
            ).filter((b) => !isForbiddenSendButton(b) && visible(b));
            if (safeBtns.length) {
              return bottomRightMost(safeBtns);
            }
          }
        }
        return null;
      },
      answers: (d) => d.querySelectorAll('div[class*="ds-markdown"]'),

      supportsFiles: true,
      // DeepSeek 同时接受合成 paste 和 file input；若预览卡片没有被及时识别，
      // 通用回退会把同一文件再传一次。固定走 input，图片和普通文档都适用。
      fileRoutes: ['input'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="file-item"], [class*="fileItem"], [class*="attach"] img, ' +
          '[class*="upload"] [class*="item"], img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'claude',
      name: 'Claude',
      url: 'https://claude.ai/new',
      host: /(^|\.)claude\.ai$/,
      input: (d) => d.querySelector('div[contenteditable="true"].ProseMirror') ||
                    d.querySelector('div[contenteditable="true"]'),
      // 图片落入后 Claude 会替换 ProseMirror 根节点；文字必须在同一节点上
      // 连续保持一小段时间，才能视为真正进入编辑器状态。
      inputSettleMs: 250,
      sendBtn: (d) => {
        const byLabel = d.querySelector('button[aria-label*="Send" i]');
        if (byLabel) return byLabel;

        // 改版把 aria-label 换掉时的兜底：输入框所在表单里的提交键
        const input = d.querySelector('div[contenteditable="true"]');
        const form = input && (input.closest?.('form') || input.parentElement?.parentElement);
        if (!form) return null;
        return bottomRightMost(
          form.querySelectorAll('button[type="submit"], button:not([type])')
        );
      },
      answers: (d) => d.querySelectorAll('div[data-is-streaming] div.font-claude-response'),

      supportsFiles: true,
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]'),
      // 只挑够特征的选择器：countChips 取"通用 blob/data 图"和这里的最大值，
      // 写得太宽（比如 [class*="file"]）会把编辑器自身的节点数进来，基线一虚高就再也判断不出增长。
      uploadedChips: (d) =>
        d.querySelectorAll(
          'button[aria-label*="Remove" i], [data-testid*="file" i], ' +
          'img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'gemini',
      name: 'Gemini',
      url: 'https://gemini.google.com/app',
      host: /(^|\.)gemini\.google\.com$/,
      input: (d) =>
        d.querySelector('div.ql-editor[contenteditable="true"]') ||
        d.querySelector('rich-textarea div[contenteditable="true"]') ||
        d.querySelector('div[contenteditable="true"]'),
      sendBtn: (d) =>
        d.querySelector('button.send-button') ||
        d.querySelector('button[aria-label*="Send" i]') ||
        d.querySelector('button[aria-label*="发送" i]') ||
        d.querySelector('.send-button-container button'),
      answers: (d) => d.querySelectorAll('message-content'),

      supportsFiles: true,
      inputSettleMs: 200,
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]') ||
        d.querySelector('uploader-file-picker input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          'uploader-file-card, [data-test-id*="file-card"], [class*="file-preview"], ' +
          '[class*="file-card"], button[aria-label*="delete" i], button[aria-label*="remove" i], ' +
          'button[aria-label*="删除" i], img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'qwen',
      name: '通义千问',
      url: 'https://chat.qwen.ai/',
      host: /(^|\.)(chat\.qwen\.ai|tongyi\.aliyun\.com|qianwen\.com)$/,
      input: (d) =>
        d.querySelector('textarea#chat-input') ||
        d.querySelector('textarea.message-input-textarea') ||
        d.querySelector('textarea[placeholder]') ||
        d.querySelector('div[data-slate-editor="true"][contenteditable="true"]') ||
        d.querySelector('div[contenteditable="true"][role="textbox"]') ||
        d.querySelector('div[contenteditable="true"]') ||
        d.querySelector('textarea'),
      sendBtn: (d) =>
        d.querySelector('button[class*="send"]:not([disabled])') ||
        d.querySelector('div.message-input-right-button-send button:not([disabled])') ||
        d.querySelector('[data-icon-type="qwpcicon-sendChat"]')?.closest('button') ||
        d.querySelector('div.message-input-right-button-send') ||
        d.querySelector('button[aria-label*="发送" i]') ||
        d.querySelector('button[aria-label*="Send" i]') ||
        d.querySelector('button[class*="send"]') ||
        d.querySelector('button[type="submit"]'),
      answers: (d) =>
        d.querySelectorAll('div[class*="qwen-markdown"], div[class*="markdown"], div.message-content'),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]') ||
        d.querySelector('.ant-upload input[type="file"]') ||
        d.querySelector('[class*="upload"] input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="file-item"], [class*="fileItem"], [class*="file-card"], [class*="fileCard"], ' +
          '[class*="attachment"], [class*="ant-upload-list-item"], [class*="upload-item"], ' +
          '[class*="preview-item"], img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'yuanbao',
      name: '腾讯元宝',
      url: 'https://yuanbao.tencent.com/chat',
      host: /(^|\.)yuanbao\.tencent\.com$/,
      input: (d) =>
        d.querySelector('div.ql-editor[contenteditable="true"]') ||
        d.querySelector('div[contenteditable="true"][role="textbox"]') ||
        d.querySelector('div[contenteditable="true"]') ||
        d.querySelector('textarea'),
      sendBtn: (d) =>
        d.querySelector('#yuanbao-send-btn') ||
        d.querySelector('a#yuanbao-send-btn') ||
        d.querySelector('a[id*="send-btn"]') ||
        d.querySelector('[class*="send-btn"]:not([class*="disabled"])') ||
        d.querySelector('span.icon-send')?.closest('a, button, div[role="button"]') ||
        d.querySelector('a[class*="send"]') ||
        d.querySelector('[class*="send-btn"]') ||
        d.querySelector('button[class*="send"]'),
      answers: (d) =>
        d.querySelectorAll('div[class*="hyc-content-text"], div[class*="agent-chat__bubble"], div[class*="content-text"]'),

      supportsFiles: true,
      inputSettleMs: 150,
      // 元宝前端不监听合成 paste/drop 上传附件，且页面初始化时 DOM 中无 input[type=file]。
      // 必须走专属 input 流程：点击工具栏添加按钮唤起 openSelectFileDialog，捕获动态创建的 input。
      fileRoutes: ['input'],
      fileInput: async (d, win, files) => {
        let existing = d.querySelector('input[type="file"]');

        const addBtn =
          d.querySelector('[data-new-input-control="add-tools"] button[aria-label*="添加"]') ||
          d.querySelector('[data-new-input-control="add-tools"] button') ||
          d.querySelector('[data-input-toolbar-left] [data-new-input-control="add-tools"] button') ||
          d.querySelector('button[aria-label*="添加" i]') ||
          d.querySelector('button[aria-label*="上传" i]') ||
          d.querySelector('[data-input-toolbar-left] button');

        if (!addBtn && existing) return existing;

        let capturedInput = null;
        const origClick = win?.HTMLInputElement?.prototype?.click;
        const interceptClick = () => {
          if (origClick) {
            win.HTMLInputElement.prototype.click = function () {
              if (this.type === 'file') {
                capturedInput = this;
                return;
              }
              return origClick.apply(this, arguments);
            };
          }
        };
        const restoreClick = () => {
          if (origClick) {
            win.HTMLInputElement.prototype.click = origClick;
          }
        };

        try {
          interceptClick();

          let menu = d.querySelector('div[role="menu"], [data-new-input-control="file-add-more"]');
          if (!menu && addBtn) {
            addBtn.click();
            for (let i = 0; i < 8; i++) {
              await sleep(30);
              if (capturedInput) break;
              menu = d.querySelector('div[role="menu"], [data-new-input-control="file-add-more"]');
              if (menu) break;
            }
          }

          if (!capturedInput && menu) {
            const items = Array.from(menu.querySelectorAll('button[role="menuitem"]'));
            const isImage = files && files.some((f) => (f.type || '').startsWith('image/'));
            let target = null;
            if (isImage) {
              target = items.find((b) => /图片|image|pic/i.test(b.textContent || '')) ||
                       items.find((b) => /本地文件|文件|file/i.test(b.textContent || ''));
            } else {
              target = items.find((b) => /本地文件|文件|file/i.test(b.textContent || '')) ||
                       items.find((b) => /图片|image|pic/i.test(b.textContent || ''));
            }
            if (!target && items.length) target = items[0];
            if (target) {
              target.click();
              if (!capturedInput) await sleep(50);
            }
          }
        } finally {
          restoreClick();
        }

        return capturedInput || d.querySelector('input[type="file"]') || existing;
      },
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[data-input-resource-area] [class*="inputFileListItem"], ' +
          '[data-input-resource-area] [class*="item"], ' +
          '[class*="inputFileListItem"], [class*="inputFileListSwiperItem"], ' +
          '[class*="inputFileListItemImage"], [class*="inputFileListItemPdf"], ' +
          '[class*="inputFileListItemClose"], [data-input-resource-area] img, ' +
          '[class*="file-item"], [class*="fileItem"], [class*="attachment"], ' +
          '[class*="file-card"], [class*="fileCard"], [class*="doc-card"], ' +
          '[class*="doc-item"], [class*="hyc-file"], [class*="upload-file"], ' +
          'img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'kimi',
      name: 'Kimi',
      url: 'https://kimi.moonshot.cn/',
      host: /(^|\.)kimi\.(moonshot\.cn|ai)$/,
      input: (d) =>
        d.querySelector('div.chat-input-editor[contenteditable="true"]') ||
        d.querySelector('[data-slate-editor="true"][contenteditable="true"]') ||
        d.querySelector('div[contenteditable="true"].chat-input') ||
        d.querySelector('div[contenteditable="true"][role="textbox"]') ||
        d.querySelector('#chat-input[contenteditable="true"]') ||
        d.querySelector('div[contenteditable="true"]') ||
        d.querySelector('textarea'),
      sendBtn: (d) =>
        d.querySelector('div.send-button-container:not(.disabled) button') ||
        d.querySelector('div.send-button-container:not(.disabled)') ||
        d.querySelector('div[class*="send-button-container"]:not(.disabled)') ||
        d.querySelector('div[class*="send-button"]:not([class*="disabled"])') ||
        d.querySelector('button[class*="send"]:not([disabled])') ||
        d.querySelector('[data-testid*="send"]') ||
        d.querySelector('button[type="submit"]:not([disabled])') ||
        d.querySelector('button[type="submit"]'),
      answers: (d) =>
        d.querySelectorAll('div.segment-content, div[class*="segment-content"], div[class*="markdown"]'),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="file-item"], [class*="fileItem"], [class*="attachment"], ' +
          '[class*="file-card"], [class*="fileCard"], [class*="doc-card"], ' +
          'img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'doubao',
      name: '豆包',
      url: 'https://www.doubao.com/chat/',
      host: /(^|\.)doubao\.com$/,
      input: (d) =>
        d.querySelector('textarea[data-testid="chat_input_input"]') ||
        d.querySelector('textarea[placeholder]') ||
        d.querySelector('div[contenteditable="true"][role="textbox"]') ||
        d.querySelector('div[contenteditable="true"]') ||
        d.querySelector('textarea'),
      sendBtn: (d) =>
        d.querySelector('button[data-testid="chat_input_send_button"]') ||
        d.querySelector('button[id*="send"]') ||
        d.querySelector('button[class*="send"]:not([disabled])') ||
        d.querySelector('button[type="submit"]:not([disabled])') ||
        d.querySelector('button[aria-label*="发送" i]') ||
        d.querySelector('button[class*="send"]') ||
        d.querySelector('button[type="submit"]'),
      answers: (d) =>
        d.querySelectorAll(
          'div[data-testid="message-content"], div[class*="message-content"], ' +
          'div[class*="message-card"], div[class*="markdown"]'
        ),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]') ||
        d.querySelector('[class*="upload"] input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="attachment"], [class*="file"], [class*="upload-item"], ' +
          'img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'chatglm',
      name: '智谱清言',
      url: 'https://chatglm.cn/',
      host: /(^|\.)chatglm\.cn$/,
      input: (d) =>
        d.querySelector('textarea#chat-input') ||
        d.querySelector('textarea[placeholder]') ||
        d.querySelector('div[contenteditable="true"][role="textbox"]') ||
        d.querySelector('div[contenteditable="true"]') ||
        d.querySelector('textarea'),
      sendBtn: (d) =>
        d.querySelector('button.send-btn') ||
        d.querySelector('div[class*="send-btn"]') ||
        d.querySelector('button[class*="send"]:not([disabled])') ||
        d.querySelector('button[type="submit"]:not([disabled])') ||
        d.querySelector('button[aria-label*="发送" i]') ||
        d.querySelector('button[class*="send"]') ||
        d.querySelector('button[type="submit"]'),
      answers: (d) =>
        d.querySelectorAll(
          'div[class*="conversation-item-response"], div[class*="message-content"], ' +
          'div[class*="markdown"], div[class*="bubble"]'
        ),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]') ||
        d.querySelector('[class*="upload"] input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="file-item"], [class*="upload-item"], [class*="attachment"], ' +
          'img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'grok',
      name: 'Grok',
      url: 'https://grok.com/',
      host: /(^|\.)grok\.com$/,
      input: (d) =>
        d.querySelector('textarea') ||
        d.querySelector('div.ProseMirror[contenteditable="true"]') ||
        d.querySelector('div[contenteditable="true"][role="textbox"]') ||
        d.querySelector('div[contenteditable="true"]'),
      sendBtn: (d) =>
        d.querySelector('button[type="submit"]:not([disabled])') ||
        d.querySelector('button[aria-label*="Send" i]') ||
        d.querySelector('button[aria-label*="Submit" i]') ||
        d.querySelector('[role="button"][aria-label*="Send" i]') ||
        d.querySelector('button[type="submit"]'),
      answers: (d) =>
        d.querySelectorAll(
          'div.message-bubble, div[class*="response"], div[class*="message-row"], div.prose, div[class*="markdown"]'
        ),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="attachment"], [class*="file-preview"], img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'perplexity',
      name: 'Perplexity',
      url: 'https://www.perplexity.ai/',
      host: /(^|\.)perplexity\.ai$/,
      input: (d) =>
        d.querySelector('textarea[placeholder*="Ask" i]') ||
        d.querySelector('textarea[placeholder*="随时" i]') ||
        d.querySelector('textarea') ||
        d.querySelector('div[contenteditable="true"]'),
      sendBtn: (d) =>
        d.querySelector('button[aria-label*="Submit" i]') ||
        d.querySelector('button[aria-label*="Send" i]') ||
        d.querySelector('button[aria-label*="提交" i]') ||
        d.querySelector('button[type="submit"]:not([disabled])') ||
        d.querySelector('button[type="submit"]'),
      answers: (d) =>
        d.querySelectorAll(
          'div.prose, div[class*="answer"], div[class*="markdown"]'
        ),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="attachment"], [class*="file-preview"], img[src^="blob:"], img[src^="data:"]'
        ),
    },
    {
      id: 'mimo',
      name: '小米 MiMo',
      url: 'https://aistudio.xiaomimimo.com/?forcePage=chat',
      host: /(^|\.)(aistudio\.xiaomimimo\.com|mimo\.mi\.com|xiaomimimo\.com)$/,
      input: (d) =>
        d.querySelector('textarea[placeholder*="尽管问"]') ||
        d.querySelector('textarea[placeholder*="Ask me anything" i]') ||
        d.querySelector('textarea[placeholder*="想做什么" i]') ||
        d.querySelector('textarea') ||
        d.querySelector('div[contenteditable="true"]'),
      sendBtn: (d) =>
        d.querySelector('button[aria-label*="发送" i]') ||
        d.querySelector('button[aria-label*="Send" i]') ||
        d.querySelector('button[title*="发送" i]') ||
        d.querySelector('button[title*="Send" i]') ||
        d.querySelector('button[class*="send"]:not([disabled])') ||
        d.querySelector('button[type="submit"]:not([disabled])') ||
        d.querySelector('[role="button"][aria-label*="发送" i]') ||
        d.querySelector('[role="button"][aria-label*="Send" i]') ||
        (() => {
          const input =
            d.querySelector('textarea[placeholder*="尽管问"]') ||
            d.querySelector('textarea');
          if (!input) return null;
          const container =
            input.closest('form, [class*="input"], [class*="chat"]') ||
            input.parentElement?.parentElement?.parentElement;
          if (!container) return null;
          const btns = Array.from(
            container.querySelectorAll('button, [role="button"], div[tabindex="0"]')
          ).filter((b) => !isForbiddenSendButton(b) && visible(b));
          return btns.length ? bottomRightMost(btns) : null;
        })(),
      answers: (d) =>
        d.querySelectorAll(
          'div[class*="markdown"], div[class*="message"], div[class*="bubble"], div[class*="prose"]'
        ),

      supportsFiles: true,
      inputSettleMs: 150,
      fileRoutes: ['paste', 'input', 'drop'],
      fileInput: (d) =>
        d.querySelector('input[type="file"][multiple]') ||
        d.querySelector('input[type="file"]') ||
        d.querySelector('[class*="upload"] input[type="file"]'),
      uploadedChips: (d) =>
        d.querySelectorAll(
          '[class*="attachment"], [class*="file"], [class*="imgItem"], [class*="upload"], img[src^="blob:"], img[src^="data:"]'
        ),
    },
  ];

  const bySite = (hostname) => ADAPTERS.find((a) => a.host.test(hostname)) || null;
  const byId = (id) => ADAPTERS.find((a) => a.id === id) || null;

  // 发送按钮排除黑名单：防止将"分享"、"取消"、"复制"等操作误判为发送键
  const FORBIDDEN_SEND_WORDS = [
    '分享', 'share', '取消', 'cancel', '全选', '创建分享',
    '复制', 'copy', '重试', '重新生成', 'regenerate',
    '删除', 'delete', '清空', 'clear', '历史', 'history',
    '折叠', '展开', '设置', 'setting', '反馈', 'feedback',
    '赞', '踩', 'like', 'dislike'
  ];

  function isForbiddenSendButton(el) {
    if (!el) return true;
    const text = (el.textContent || '').trim().toLowerCase();
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    const title = (el.getAttribute('title') || '').toLowerCase();
    const testid = (el.getAttribute('data-testid') || '').toLowerCase();
    return FORBIDDEN_SEND_WORDS.some(
      (w) => text.includes(w) || label.includes(w) || title.includes(w) || testid.includes(w)
    );
  }

  // 自动检测并退出 DeepSeek 的"选择对话"（分享）模式
  function exitDeepSeekSelectMode(d) {
    if (!d || typeof d.querySelectorAll !== 'function') return;
    try {
      const headers = Array.from(d.querySelectorAll('div, span, h1, h2, h3, header'));
      const hasSelectMode = headers.some(
        (el) => el.textContent?.trim() === '选择对话' && visible(el)
      );
      if (hasSelectMode) {
        const cancelBtn = Array.from(d.querySelectorAll('button, [role="button"], div, span')).find(
          (el) => el.textContent?.trim() === '取消' && visible(el)
        );
        if (cancelBtn) {
          cancelBtn.click();
        }
      }
    } catch (_) {}
  }

  /*
   * "看起来是个能点的控件吗"。getBoundingClientRect 在测试用的假 DOM 里不存在，
   * 拿不到尺寸时返回 true —— 判断不了就别否决，否则选择器在测试环境里直接抛错。
   */
  function visible(el) {
    if (!el) return false;
    if (typeof el.getBoundingClientRect !== 'function') return true;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  }

  // 在候选里挑最靠右下角的那个（发送键通常在输入框右下）。取不到坐标就退回第一个。
  function bottomRightMost(els) {
    let best = null;
    let bestScore = -Infinity;
    for (const el of els) {
      if (!visible(el)) continue;
      if (isForbiddenSendButton(el)) continue;
      if (typeof el.getBoundingClientRect !== 'function') return el;
      const r = el.getBoundingClientRect();
      const score = r.right + r.bottom;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  // React 受控组件会忽略直接赋值的 .value，必须走原型上的 setter 再派发 input。
  function setTextareaValue(win, el, text) {
    const desc = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
  }

  const inputText = (el) => (el ? (el.value ?? el.innerText ?? el.textContent ?? '') : '');
  const normText = (s) =>
    String(s || '')
      .replace(/\r\n/g, ' ')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ProseMirror / Quill / Lexical 用合成 paste 最稳；改 innerHTML 会让编辑器内部状态脱节。
  async function setContentEditable(win, doc, el, text) {
    el.focus();

    const selectContents = () => {
      try {
        doc.execCommand('selectAll', false, null);
      } catch {
        const sel = win.getSelection();
        sel.removeAllRanges();
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
      }
    };
    selectContents();

    const dt = new win.DataTransfer();
    dt.setData('text/plain', text);
    const pasteEvt = new win.ClipboardEvent('paste', {
      clipboardData: dt,
      bubbles: true,
      cancelable: true,
    });
    const handled = !el.dispatchEvent(pasteEvt);

    const probe = normText(text).slice(0, 25);

    /*
     * 关键修复：给异步编辑器（如 ChatGPT 的 ProseMirror / Lexical）留出处理 paste 的时间。
     * 若直接在同一调用栈中同步检查，DOM 尚未更新，就会误判为 paste 失败并触发下面的 execCommand，
     * 导致 paste 和 execCommand 各自插入了一遍（出现重复，如 "idea-setidea-set"）。
     *
     * 如果 paste 被站点拦截处理（handled 为 true），轮询检查文字是否已经落入 DOM；
     * 只有在等待后 DOM 中仍无文字时（如 Claude 拦截 paste 但不写入文字），才降级调用 execCommand。
     */
    let inserted = false;
    if (probe) {
      // 若 paste 被站点接手，等待最多 250ms（每 25ms 轮询一次）
      const iters = handled ? 10 : 2;
      for (let i = 0; i < iters; i++) {
        if (normText(inputText(el)).includes(probe)) {
          inserted = true;
          break;
        }
        await sleep(25);
      }
    }

    if (!inserted && probe) {
      selectContents();
      doc.execCommand('insertText', false, text);
    }

    // 额外触发 input 事件，确保 React/Vue 等框架的状态同步
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  async function fillInput(site, win, doc, text) {
    const el = site.input(doc);
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') setTextareaValue(win, el, text);
    else await setContentEditable(win, doc, el, text);
    return true;
  }

  /*
   * 填字并确认真的落进去了，没落进去就隔一会儿重填。
   *
   * 附件路径会扰动输入框：站点收下图片后经常重建编辑器（Claude 的 ProseMirror
   * 就是这样），此时填入的文字会被这次重建吞掉，最后只发出图片。同一个 tick 里
   * 重试没用 —— 编辑器还在重建中，必须等它安顿下来再填。
   *
   * 返回 { ok, verified }：ok=false 只表示压根没找到输入框；verified=false
   * 表示填了但读不回来（可能只是读取方式对不上），由调用方决定是否继续。
   */
  async function fillInputVerified(site, win, doc, text, tries = 4) {
    const probe = normText(text).slice(0, 25);
    let foundInput = false;

    const currentMatch = () => {
      const current = site.input(doc);
      return current && (probe ? normText(inputText(current)).includes(probe) : true) ? current : null;
    };

    for (let i = 0; i < tries; i++) {
      if (!site.input(doc)) {
        await sleep(200);
        continue;
      }
      foundInput = true;

      // 如果当前输入框已经包含目标文本（例如上一次 paste 虽迟但已成功到达），严禁重复填入
      if (probe && currentMatch()) {
        return { ok: true, verified: true };
      }

      if (!(await fillInput(site, win, doc, text))) {
        await sleep(200);
        continue;
      }
      if (!probe) return { ok: true, verified: true };

      // 给异步编辑器一次落字机会，再决定是否重填，避免迟到的 paste 造成重复。
      let matched = currentMatch();
      if (!matched) {
        await sleep(200);
        matched = currentMatch();
      }
      if (!matched) continue;

      const settleMs = site.inputSettleMs || 0;
      if (!settleMs) return { ok: true, verified: true };

      await sleep(settleMs);
      const stable = currentMatch();
      if (stable) return { ok: true, verified: true };
    }
    return {
      ok: false,
      verified: false,
      error: foundInput ? '文字未能填入' : '未找到输入框',
    };
  }

  /*
   * 附件注入。chrome.runtime.sendMessage 只能传 JSON，File 对象过不去，
   * 所以面板把文件读成 base64，在这里重建成真正的 File 再塞进站点的 file input。
   */
  function base64ToFile(win, { name, type, data }) {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new win.File([bytes], name, { type: type || 'application/octet-stream' });
  }

  function toFileList(win, files) {
    // input.files 只接受 FileList，必须借 DataTransfer 造一个。
    const dt = new win.DataTransfer();
    for (const f of files) dt.items.add(base64ToFile(win, f));
    return dt;
  }

  /*
   * 首选路径：合成 paste 事件，等价于用户在输入框里 Ctrl+V 贴图。
   * 比塞隐藏的 input[type=file] 可靠得多 —— 后者的存在与否、是否被 React
   * 监听都随站点改版变化，而"支持粘贴图片"是这些站点的核心交互，不会变。
   * 返回 false 表示没人处理这个 paste，调用方该走兜底。
   */
  function pasteFiles(site, win, doc, files) {
    const el = site.input(doc);
    if (!el) return false;
    el.focus();
    const dt = toFileList(win, files);
    const notHandled = el.dispatchEvent(
      new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    );
    return !notHandled; // preventDefault 被调用 => 站点接手了
  }

  // 兜底路径：直接塞 file input。
  async function setFileInput(site, win, doc, files) {
    if (!site.fileInput) return false;
    let el = null;
    try {
      el = await site.fileInput(doc, win, files);
    } catch (_) {
      el = null;
    }
    if (!el) return false;
    try {
      el.files = toFileList(win, files).files;
    } catch (_) {}
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
    if (typeof el.onchange === 'function') {
      try {
        el.onchange({ target: el });
      } catch (_) {}
    }
    return true;
  }

  // 拖拽路径：合成 drop 事件，模拟文件拖入输入框。
  function dropFiles(site, win, doc, files) {
    const el = site.dropTarget?.(doc) || site.input(doc);
    if (!el) return false;
    el.focus?.();
    const dt = toFileList(win, files);
    let dropEvt;
    if (typeof win.DragEvent === 'function') {
      dropEvt = new win.DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
    } else {
      dropEvt = new win.Event('drop', { bubbles: true, cancelable: true });
      dropEvt.dataTransfer = dt;
    }
    const notHandled = el.dispatchEvent(dropEvt);
    return !notHandled;
  }

  /*
   * 注入附件。默认按 paste -> input 回退；站点可用 fileRoutes 限制路径。
   * 每条实际派发的路径都要"验证后才算成功"。
   *
   * 不能只看 paste 事件的 preventDefault：站点可能对所有 paste 都拦，
   * 那样明明没收下文件我们也以为成了（ChatGPT 就是这样丢图的）。所以注入后
   * 实际数缩略图有没有比基线多，没多就换另一条路。
   *
   * verifyMs 是两条路径共用的总预算，不是每条各给一份：站点认不出缩略图时
   * 两条路都会等满，per-route 预算会让这里凭空多等一倍，表现为界面长时间"上传中"。
   */
  async function attachFiles(site, win, doc, files, opts = {}) {
    if (!files || !files.length) return { ok: true, attached: 0, via: null };
    if (!site.supportsFiles) {
      return { ok: false, error: `${site.name} 暂不支持附件` };
    }

    const verifyMs = opts.verifyMs ?? 3000;
    const baseline = opts.baseline ?? countChips(site, doc);
    const budgetEnd = Date.now() + verifyMs;
    const grew = async () => {
      // 至少查一次：预算已经用光时也要给刚派发的这条路一个机会。
      do {
        if (countChips(site, doc) > baseline) return true;
        await sleep(200);
      } while (Date.now() < budgetEnd);
      return false;
    };

    const routeFns = {
      paste: () => pasteFiles(site, win, doc, files),
      input: () => setFileInput(site, win, doc, files),
      drop: () => dropFiles(site, win, doc, files),
    };
    const routes = (site.fileRoutes || ['paste', 'input', 'drop'])
      .filter((via) => routeFns[via])
      .map((via) => [via, routeFns[via]]);

    let dispatched = false;
    for (const [via, run] of routes) {
      if (!await run()) continue; // 这条路径压根没派发出去
      dispatched = true;
      if (await grew()) return { ok: true, attached: files.length, via };
    }

    // 派发出去了但数不到缩略图：可能只是认不出预览，交给上层提示而不是判死
    if (dispatched) {
      return { ok: true, attached: files.length, via: 'unverified', unverified: true };
    }
    return { ok: false, error: '未找到 file input，粘贴也没人接手（两条路径都失败）' };
  }

  /*
   * 数一下页面上的附件缩略图。类名随站点改版而变，所以主要靠一个跨站点稳定的
   * 特征：本地文件在页面上预览时 src 是 blob:/data:。类名候选只作补充。
   */
  function countChips(site, doc) {
    let n = 0;
    try {
      n = doc.querySelectorAll('img[src^="blob:"], img[src^="data:"]').length;
    } catch { n = 0; }
    if (site.uploadedChips) {
      try {
        const extra = site.uploadedChips(doc);
        if (extra && extra.length > n) n = extra.length;
      } catch { /* 选择器失效不该让发送崩掉 */ }
    }
    return n;
  }

  /*
   * 等站点把文件收下。判断依据是缩略图数量相对注入前的基线有增长 —— 比
   * "数量达到 N"稳健，因为页面上本来可能已有别的 blob 图。
   *
   * 认不出来时超时放行，且超时值要短：卡住不发比附件没跟上更糟，而且
   * 按钮型站点还有 waitSendable 这道天然闸门（上传中发送键是 disabled 的）。
   *
   * 只在 attachFiles 已经确认站点收下附件时才调用 —— 没确认过就等，等的是同一个
   * 已经失败过的信号，只会白卡满 maxMs。
   */
  async function waitForUploads(site, doc, baseline, expected, maxMs = 15000) {
    if (!expected) return true;
    const target = (baseline || 0) + expected;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      const n = countChips(site, doc);
      // 达到目标数，或至少比基线多了（站点可能把多图合并成一个预览）
      if (n >= target || n > (baseline || 0)) return true;
      await sleep(250);
    }
    return false;
  }

  function sendable(btn) {
    if (!btn) return false;
    const ariaDisabled = btn.getAttribute('aria-disabled');
    const disabled = btn.disabled;
    if (ariaDisabled === 'true' || disabled) return false;
    const cls = String(btn.className || '');
    if (cls.includes('disabled') || cls.includes('sendNot')) return false;
    return true;
  }

  function pressEnter(site, win, doc) {
    const el = site.input(doc);
    if (!el) return false;
    el.focus();

    // 对于textarea，先触发一次input事件确保React状态同步
    if (el.tagName === 'TEXTAREA') {
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
    }

    // 派发Enter键事件
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(
        new win.KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
          bubbles: true, cancelable: true,
        })
      );
    }
    return true;
  }

  /*
   * 等发送按钮从 disabled 变可用。轮询间隔取小值：这段等待是"同时发送"的主要
   * 延迟来源，越短各站点提交时刻越齐。
   *
   * submitMode:'enter' 不依赖按钮，sendStateUnreliable 的站点读不出按钮状态
   * （aria-disabled 和 disabled 都是空），等下去只会白等满 maxMs，都直接放行。
   */
  async function waitSendable(site, doc, maxMs = 2500) {
    if (site.submitMode === 'enter' || site.sendStateUnreliable) return true;
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (sendable(site.sendBtn(doc))) return true;
      await sleep(60);
    }
    return false; // 按钮始终不可用，submit 时回退到回车
  }

  function submit(site, win, doc) {
    // 对于使用enter模式的站点，优先回车，失败时尝试按钮
    if (site.submitMode === 'enter') {
      if (pressEnter(site, win, doc)) {
        return { ok: true, via: 'enter' };
      }
      // 回车失败，尝试按钮
      const btn = site.sendBtn(doc);
      if (sendable(btn)) {
        btn.click();
        return { ok: true, via: 'button' };
      }
      return { ok: false, error: '既无法触发回车也无可用按钮' };
    }

    const btn = site.sendBtn(doc);

    // sendStateUnreliable 的站点读不出按钮状态，按 sendable 判断会一律跳到回车，
    // 而这些站点的回车又不一定提交。提交确认站点由 submitVerified 负责重试。
    if (btn && (sendable(btn) || site.sendStateUnreliable)) {
      btn.click();
      return { ok: true, via: 'button' };
    }

    // 按钮不可用，尝试回车
    return pressEnter(site, win, doc)
      ? { ok: true, via: 'enter' }
      : { ok: false, error: '既无可用按钮也无输入框' };
  }

  /*
   * DeepSeek 的发送键没有可靠 disabled 状态，click() 也不会告诉调用方是否提交。
   * 图片仍在处理时点击会被静默忽略；以编辑器内容消失作为提交成功信号，未消失
   * 就等待后重试。只给 verifySubmit 站点使用，避免改变其他站点的同时发送路径。
   */
  async function submitVerified(site, win, doc, maxMs = 10000) {
    const originalText = inputText(site.input(doc)).trim();
    const textProbe = originalText.slice(0, 40);
    const originalChips = countChips(site, doc);
    if (!textProbe && !originalChips) {
      return { ok: false, error: '发送前输入内容为空', attempts: 0 };
    }

    const completed = () => {
      if (textProbe) return !inputText(site.input(doc)).includes(textProbe);
      return countChips(site, doc) < originalChips;
    };

    const deadline = Date.now() + maxMs;
    let attempts = 0;
    let last = null;

    while (Date.now() < deadline) {
      if (attempts && completed()) {
        return { ok: true, via: last?.via, verified: true, attempts };
      }

      last = submit(site, win, doc);
      if (last.via) attempts++;

      const confirmMs = Math.min(450, Math.max(0, deadline - Date.now()));
      if (confirmMs) await sleep(confirmMs);
      if (completed()) {
        return { ok: true, via: last.via, verified: true, attempts };
      }

      // 关键加固：如果按钮点击未生效，交替尝试一次回车提交
      if (attempts > 0 && attempts % 2 === 1) {
        pressEnter(site, win, doc);
        if (completed()) {
          return { ok: true, via: 'enter', verified: true, attempts: attempts + 1 };
        }
      }

      const retryMs = Math.min(300, Math.max(0, deadline - Date.now()));
      if (retryMs) await sleep(retryMs);
    }

    return {
      ok: false,
      error: textProbe ? '点击发送后文字仍在输入框' : '点击发送后附件仍在输入框',
      attempts,
    };
  }

  function latestAnswer(site, doc) {
    const nodes = site.answers(doc);
    if (!nodes || !nodes.length) return null;
    const text = (nodes[nodes.length - 1].innerText || '').trim();
    return text || null;
  }

  /*
   * 各站点没有统一的"生成结束"信号，靠 DOM 属性判断每次改版都会失效。
   * 轮询最新回答的文本长度，连续 STABLE_ROUNDS 次不变即认为流式结束 —— 与站点无关。
   */
  const POLL_MS = 500;
  const STABLE_ROUNDS = 4; // 连续 2s 无变化
  const MAX_WAIT_MS = 180000;

  async function waitForStableAnswer(site, doc, onTick, maxWait) {
    const deadline = Date.now() + (maxWait ?? MAX_WAIT_MS);
    let prev = null;
    let stable = 0;
    while (Date.now() < deadline) {
      const cur = latestAnswer(site, doc);
      if (cur && cur === prev) {
        if (++stable >= STABLE_ROUNDS) return cur;
      } else {
        stable = 0;
      }
      prev = cur;
      if (onTick) onTick(cur ? cur.length : 0);
      await sleep(POLL_MS);
    }
    return prev; // 超时也交出当前内容，好过完全没有
  }

  function buildComparePrompt(question, entries) {
    const blocks = entries.map((e) => `【回答 - ${e.name}】\n${e.text}`).join('\n\n---\n\n');
    return `你现在担任本次多模型对决的“中立评审裁判”。下面是各家大模型针对同一问题的作答，请对其进行客观、犀利、结构极简的横向裁决。请只输出裁判对比内容，不要重新回答问题。

【原问题】
${question || '(见各回答内容)'}

----------------------------------------
【各模型回答汇总】
${blocks}
----------------------------------------

请严格按照以下 3 个部分直接输出（前两部分简单直接，第三部分必须详实充实）：

### 一、 直观打分（简单评价）
按回答质量从高到低排列，给出 10 分制评分及一句话核心点评：
- 🥇 **[第1名模型]**（X.X 分）：一句话核心优势（胜出理由）。
- 🥈 **[第2名模型]**（X.X 分）：一句话点评。
- 🥉 **[后续模型]**（X.X 分）：一句话点评（指出核心短板或失分项）。
👉 **【定夺采纳】**：明确指定优先采用谁的方案。

### 二、 各自突出亮点和不足
简明扼要地列出每个参评模型的独到长处与核心硬伤（条理清晰，拒绝啰嗦）：
- **[模型A]**：
  - ✨ 突出亮点：...
  - ⚠️ 核心不足：...
- **[模型B]**：
  - ✨ 突出亮点：...
  - ⚠️ 核心不足：...

### 三、 整理采纳方案
【核心硬性要求】必须根据上述各模型的实际回答内容，详细、系统、完整地展示出最终采纳方案：
1. 完整吸纳各家实际回答中的具体实操步骤、关键配置、核心论据或技术细节；
2. 纠正并剔除各回答中存在的瑕疵、漏洞与错误；
3. 若涉及代码、命令、排查步骤或实施流程，必须依据各模型的实际内容详细写出完整可落地的最终版本（严禁一笔带过或省略，确保信息充实详尽，用户无需再翻阅其他模型的零散回答）。`;
  }

  root.AskManyAdapters = {
    ADAPTERS, bySite, byId,
    fillInput, fillInputVerified, normText, sendable, waitSendable, submit, submitVerified, pressEnter,
    attachFiles, waitForUploads, base64ToFile, countChips, pasteFiles, setFileInput,
    latestAnswer, waitForStableAnswer, buildComparePrompt,
    POLL_MS, STABLE_ROUNDS, MAX_WAIT_MS, sleep,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
