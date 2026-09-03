/*
 * 注入到每个 AI 站点（含 iframe 内）。只负责听面板的指令、操作本页 DOM、回报结果。
 * 所有 DOM 细节都在 adapters.js 里，这里不重复实现。
 */
(function () {
  'use strict';

  const A = globalThis.AskManyAdapters;
  if (!A) return;

  const site = A.bySite(location.hostname);
  if (!site) return;

  // 只接受面板直接创建的 AI iframe。普通站点标签页和 AI 页面内部的
  // 同源子 frame 也会命中 manifest；后者若上报相同 siteId，会覆盖正确
  // frameId，导致后续指令被投递到没有输入框的子 frame。
  const inFrame = window.top !== window.self;
  const isDirectChildFrame = inFrame && window.parent === window.top;
  if (!isDirectChildFrame) return;

  // 让面板知道"我在这个 frame 里，可以接指令了"。
  // iframe 内的 content script 无法直接被面板 postMessage 找到（跨源），
  // 所以走 runtime 消息由 background 按 frameId 投递。
  chrome.runtime.sendMessage({ type: 'frame-ready', siteId: site.id, inFrame }).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (!msg || msg.siteId !== site.id) return false;

    if (msg.type === 'ping') {
      respond({ ok: true, siteId: site.id, hasInput: !!site.input(document) });
      return true;
    }

    /*
     * 发送拆成两阶段，好让各站点真正同时提交：
     *   prepare —— 填入文本、等自己的发送按钮变可用（各站点耗时差别很大）
     *   fire    —— 立即提交，不再有任何等待
     * 面板先并发 prepare 到全部就绪，再并发 fire，提交时刻就对齐了。
     */
    if (msg.type === 'prepare') {
      const files = msg.files || [];

      /*
       * 先注入附件再填文字：注入后站点立刻开始上传，这段时间正好用来填文字，
       * 两段等待重叠而不是相加。注入失败不阻断纯文字发送 —— 附件是增强，
       * 不该让整条消息发不出去，所以只回报 fileError 由面板提示。
       */
      // 注入前先数一遍已有缩略图，之后靠"比基线多了"判断站点收下了文件。
      const baseline = files.length ? A.countChips(site, document) : 0;

      (async () => {
        let fileError = null;
        let attached = 0;
        let via = null;

        if (files.length) {
          const r = await A.attachFiles(site, window, document, files,
                                       { baseline, verifyMs: msg.verifyMs });
          if (r.ok) {
            attached = r.attached;
            via = r.via;
            if (r.unverified) fileError = '附件已投递但未能确认站点收下';
          } else {
            fileError = r.error;
          }
        }

        /*
         * 附件注入后才填文字：站点收下图片时会重建输入框（ChatGPT 贴图、
         * Claude 的 ProseMirror 都会），顺序反了刚填的文字会被这次重建吞掉，
         * 最后只发出图片。即便顺序对了也可能撞上重建，所以填完要回读确认。
         */
        const filled = await A.fillInputVerified(site, window, document, msg.text);
        if (!filled.ok) {
          return { ok: false, error: filled.error || '文字未能填入', siteId: site.id };
        }

        /*
         * 只有 attachFiles 确认过站点收下附件，再等上传完成才有意义。
         * 它没确认（unverified）时说明这个判断信号在本站点上就是不灵的，
         * 再等一遍等的是同一个信号，只会白卡满 uploadMs（表现为长时间"上传中"）。
         */
        const shouldWaitUpload = attached && via !== 'unverified';
        const [armed, uploaded] = await Promise.all([
          A.waitSendable(site, document, msg.armMs),
          shouldWaitUpload
            ? A.waitForUploads(site, document, baseline, attached, msg.uploadMs)
            : Promise.resolve(true),
        ]);

        // 上传没等到确认也放行：可能只是选择器认不出缩略图，不代表真的失败。
        if (attached && !uploaded && !fileError) fileError = '未能确认附件上传完成';
        return { ok: true, armed, attached, via, fileError, siteId: site.id };
      })()
        .then(respond)
        .catch((e) => respond({ ok: false, error: e.message, siteId: site.id }));
      return true;
    }

    if (msg.type === 'fire') {
      if (site.verifySubmit) {
        A.submitVerified(site, window, document, site.submitVerifyMs)
          .then((r) => respond({ ...r, siteId: site.id }))
          .catch((e) => respond({ ok: false, error: e.message, siteId: site.id }));
        return true;
      }
      const r = A.submit(site, window, document);
      respond({ ...r, siteId: site.id });
      return true;
    }

    if (msg.type === 'peek') {
      const t = A.latestAnswer(site, document);
      respond({ ok: true, siteId: site.id, length: t ? t.length : 0 });
      return true;
    }

    if (msg.type === 'collect') {
      A.waitForStableAnswer(site, document, null, msg.maxWait)
        .then((text) =>
          respond({ ok: true, siteId: site.id, name: site.name, text: text || null })
        )
        .catch((e) => respond({ ok: false, error: e.message, siteId: site.id }));
      return true;
    }

    return false;
  });
})();
