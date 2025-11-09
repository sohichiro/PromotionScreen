/** =========================
 *  設定
 * ========================= */
const SP = PropertiesService.getScriptProperties();
const CONF = {
  DBX_APP_KEY:        SP.getProperty('DBX_APP_KEY'),
  DBX_APP_SECRET:     SP.getProperty('DBX_APP_SECRET'),
  DBX_REFRESH_TOKEN:  SP.getProperty('DBX_REFRESH_TOKEN'),
  DBX_INBOX_PATH:     SP.getProperty('DBX_INBOX_PATH') || '/inbox',
  DBX_CURSOR_KEY:     'DBX_CURSOR',

  SLACK_BOT_TOKEN:        SP.getProperty('SLACK_BOT_TOKEN'),
  SLACK_SIGNING_SECRET:   SP.getProperty('SLACK_SIGNING_SECRET'),
  SLACK_CHANNEL_ID:       SP.getProperty('SLACK_CHANNEL_ID'),

  DRIVE_OK_FOLDER_ID: SP.getProperty('DRIVE_OK_FOLDER_ID'),
  DRIVE_NG_FOLDER_ID: SP.getProperty('DRIVE_NG_FOLDER_ID'),
  SHEET_ID:           SP.getProperty('SHEET_ID'),
};

/** =========================
 *  Dropbox: Token Refresh
 * ========================= */
function getDropboxAccessToken_() {
  const resp = UrlFetchApp.fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'post',
    payload: {
      grant_type: 'refresh_token',
      refresh_token: CONF.DBX_REFRESH_TOKEN,
      client_id: CONF.DBX_APP_KEY,
      client_secret: CONF.DBX_APP_SECRET,
    },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText() || '{}');
  if (!data.access_token) throw new Error('Dropbox token refresh failed: ' + resp.getContentText());
  return data.access_token;
}

/** =========================
 *  Dropbox: 初期カーソル
 * ========================= */
function initDropboxCursor() {
  const token = getDropboxAccessToken_();
  const resp = UrlFetchApp.fetch('https://api.dropboxapi.com/2/files/list_folder', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      path: CONF.DBX_INBOX_PATH,
      recursive: false,
      include_media_info: true,
      include_deleted: false,
    }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText() || '{}');
  if (!data.cursor) throw new Error('list_folder failed: ' + resp.getContentText());
  SP.setProperty(CONF.DBX_CURSOR_KEY, data.cursor);
}

/** =========================
 *  Dropbox: 差分ポーリング（時間トリガー用）
 * ========================= */
function pollDropboxInbox() {
  const token = getDropboxAccessToken_();
  let cursor = SP.getProperty(CONF.DBX_CURSOR_KEY);
  if (!cursor) {
    initDropboxCursor();
    cursor = SP.getProperty(CONF.DBX_CURSOR_KEY);
  }
  const resp = UrlFetchApp.fetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ cursor }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText() || '{}');
  if (data.cursor) SP.setProperty(CONF.DBX_CURSOR_KEY, data.cursor);

  const files = (data.entries || []).filter(e => e['.tag'] === 'file');
  if (files.length === 0) return;

  files.forEach(f => {
    const link = getTemporaryLink_(token, f.path_lower);
    postNewPhotoToSlack_(f, link);
  });
}

/** 画像プレビュー用の一時URL（4時間有効） */
function getTemporaryLink_(accessToken, pathLower) {
  const resp = UrlFetchApp.fetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessToken },
    payload: JSON.stringify({ path: pathLower }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText() || '{}');
  if (!data.link) throw new Error('get_temporary_link failed: ' + resp.getContentText());
  return data.link;
}

/** =========================
 *  Slack: 新着写真を投稿（Block Kit）
 * ========================= */
function postNewPhotoToSlack_(file, previewUrl) {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: `*新着写真*\n*${escapeMrkdwn_(file.name)}*\n${new Date().toLocaleString('ja-JP')}` } },
    { type: 'image', image_url: previewUrl, alt_text: file.name },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: 'OK → 公開へ' }, style: 'primary',
          action_id: 'ok_move', value: JSON.stringify({ path: file.path_lower, name: file.name }) },
        { type: 'button', text: { type: 'plain_text', text: 'NG（理由入力）' }, style: 'danger',
          action_id: 'ng_reason', value: JSON.stringify({ path: file.path_lower, name: file.name }) }
      ]
    }
  ];
  const resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + CONF.SLACK_BOT_TOKEN },
    payload: { channel: CONF.SLACK_CHANNEL_ID, text: '新着写真', blocks: JSON.stringify(blocks) },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText() || '{}');
  if (!data.ok) throw new Error('chat.postMessage failed: ' + resp.getContentText());
}

/** =========================
 *  Slack Interactivity 受け口（WebApp）
 * ========================= */
function doPost(e) {
  try {
    // ① Dropbox Webhook っぽいか？（署名ヘッダ有無で判定）
    const isDbx = !!(e.headers && (e.headers['X-Dropbox-Signature'] || e.headers['x-dropbox-signature']));
    if (isDbx) {
      // まず全量ログ
      paperLog_(`[DBX][POST] headers=${JSON.stringify(e.headers || {})}`);
      // body は小さく、user_ids しか来ない
      const bodyStr =
        (e.postData && e.postData.getDataAsString ? e.postData.getDataAsString() : (e.postData && e.postData.contents)) || '';
      paperLog_(`[DBX][POST] body=${bodyStr}`);

      // 署名検証（失敗しても "ok" を返す運用もあるが、まずは明示的に失敗を返す）
      if (!verifyDbxWebhook_(e)) {
        paperLog_(`[DBX][POST] verifyDbxWebhook_ FAILED`);
        return ContentService.createTextOutput('invalid dbx signature')
          .setMimeType(ContentService.MimeType.TEXT);
      }

      paperLog_(`[DBX][POST] verifyDbxWebhook_ OK`);
      handleDropboxWebhook_(e); // 差分取り→Slack投稿

      // Dropbox Webhook は 200/OK をすぐ返す
      return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
    }
    
    if (!shouldBypassVerify_()) {
      if (!verifySlackSignature_(e)) {
        return ContentService.createTextOutput('invalid signature').setMimeType(ContentService.MimeType.TEXT);
      }
    }
    const payloadRaw = (e.parameter && e.parameter.payload) || '';
    if (!payloadRaw) return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);

    const payload = JSON.parse(payloadRaw);

    if (payload.type === 'block_actions') {
      const action  = payload.actions[0];
      const userId  = payload.user.id;
      const channel = payload.channel.id;
      const ts      = payload.message.ts;
      const val     = JSON.parse(action.value);

      if (action.action_id === 'ok_move') {
        try {
          // 1) 押した瞬間に即更新（権限いらず）
          replaceOriginalViaResponseUrl_(payload.response_url, payload.message.blocks,`⏳ 処理開始 by <@${userId}>`, false);

          // 2) 本処理（Dropbox→Drive）
          const info = handleOK_(val.path, val.name);

          // 3) 結果を追記＋ボタン無効化
          replaceOriginalViaResponseUrl_(payload.response_url, payload.message.blocks,`✅ 承認済み by <@${userId}> → <${info.webViewLink}|Driveに保存>`, true);

          // 4) スプシ
          logSheetSafe_({ action:'OK', reason:'', name:val.name, dropboxPath:val.path, slackUser:userId, slackTs:ts, driveId:info.fileId, driveUrl:info.webViewLink });

        } catch (err) {
          replaceOriginalViaResponseUrl_(payload.response_url, payload.message.blocks,`⚠️ OK処理エラー: ${escapeMrkdwn_(String(err))}`, false);
        }
        return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
      }

      if (action.action_id === 'ng_reason') {
        try {
          // payload から必要情報を渡す（response_url と元 blocks を含める）
          openNgModal_(payload.trigger_id, val, channel, ts, payload.response_url, payload.message.blocks);
        } catch (err) {
          // 予備：失敗をメッセージに表示（response_urlが使える）
          try {
            replaceOriginalViaResponseUrl_(payload.response_url, payload.message.blocks,`⚠️ モーダル起動エラー: ${escapeMrkdwn_(String(err))}`, false);
          } catch (_) {}
        }
        return ContentService.createTextOutput('').setMimeType(ContentService.MimeType.TEXT);
      }
    }

    if (payload.type === 'view_submission' && payload.view?.callback_id === 'ng_modal') {
      const meta = JSON.parse(payload.view.private_metadata || '{}');

      const st   = payload.view.state.values;
      const reasonSel  = st.reason_block?.reason_select?.selected_option?.text?.text || '';
      const reasonText = st.reason_block2?.reason_text?.value || '';
      const reason     = [reasonSel, reasonText].filter(Boolean).join(' / ') || '（未記入）';
      const userId = payload.user?.id || 'unknown';

      // ★重い処理をせず、キューに詰めて即ACK
      enqueueNgJob_({
        name: meta.name,
        path: meta.path,
        ts: meta.ts,
        userId,
        reason,
        responseUrl: meta.responseUrl,
        blocks: meta.blocks
      });

      // モーダルを即閉じる（ACK）
      return ContentService
        .createTextOutput(JSON.stringify({ response_action: 'clear' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } catch (_) {
    return ContentService.createTextOutput('error').setMimeType(ContentService.MimeType.TEXT);
  }
}

function shouldBypassVerify_() {
  const v = PropertiesService.getScriptProperties().getProperty('SLACK_DEV_BYPASS_SIG');
  return v === '1';
}

/** Slack署名検証 */
function verifySlackSignature_(e) {
  try {
    const sig = e.headers['X-Slack-Signature'] || e.headers['x-slack-signature'];
    const ts  = e.headers['X-Slack-Request-Timestamp'] || e.headers['x-slack-request-timestamp'];
    if (!sig || !ts) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(ts)) > 60 * 5) return false;

    const body = e.postData?.contents || '';
    const base = `v0:${ts}:${body}`;
    const mac  = Utilities.computeHmacSha256Signature(base, CONF.SLACK_SIGNING_SECRET);
    const hex  = mac.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
    const expected = `v0=${hex}`;
    return Utilities.computeSecureSignature(expected) === Utilities.computeSecureSignature(sig);
  } catch (_) { return false; }
}

/** =========================
 *  OK処理：Dropbox→DL→Drive保存
 * ========================= */
function handleOK_(pathLower, name){
  const token = getDropboxAccessToken_();

  // Drive フォルダIDの妥当性を事前チェック（分かりやすいエラーに）
  let folder;
  try {
    folder = DriveApp.getFolderById(CONF.DRIVE_OK_FOLDER_ID);
    // アクセス権が無い/存在しないとここで例外
  } catch (e) {
    throw new Error('DriveフォルダIDが不正 or 権限不足: DRIVE_OK_FOLDER_ID=' + CONF.DRIVE_OK_FOLDER_ID);
  }

  // Dropbox download: 空ボディ + contentType 明示
  const resp = UrlFetchApp.fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path: pathLower })
    },
    contentType: 'text/plain',
    payload: '',
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Dropbox download failed: ' + resp.getContentText());
  }

  const blob = resp.getBlob().setName(name);
  const file = folder.createFile(blob); // ここも例外が出たら上のtry/catchで拾われる
  return { fileId: file.getId(), webViewLink: `https://drive.google.com/file/d/${file.getId()}/view` };
}

/** NG処理：DropboxからDL→DriveのNGフォルダへ保存（Dropboxは変更しない） */
function handleNGCopyToDrive_(pathLower, name){
  // Drive NGフォルダの妥当性チェック
  let ngFolder;
  try {
    ngFolder = DriveApp.getFolderById(CONF.DRIVE_NG_FOLDER_ID);
  } catch (e) {
    throw new Error('Drive NGフォルダIDが不正 or 権限不足: DRIVE_NG_FOLDER_ID=' + CONF.DRIVE_NG_FOLDER_ID);
  }

  // Dropbox からダウンロード（OKと同じ要件：空ボディ＋contentType明示）
  const token = getDropboxAccessToken_();
  const resp = UrlFetchApp.fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + token,
      'Dropbox-API-Arg': JSON.stringify({ path: pathLower })
    },
    contentType: 'text/plain',
    payload: '',
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Dropbox download failed (NG): ' + resp.getContentText());
  }

  // Drive の NG フォルダへ保存
  const blob = resp.getBlob().setName(name);
  const file = ngFolder.createFile(blob);
  return { fileId: file.getId(), webViewLink: `https://drive.google.com/file/d/${file.getId()}/view` };
}


/** =========================
 *  Slackメッセージ更新（ボタン無効化）
 * ========================= */
// function finalizeMessage_(channel, ts, statusLine){
//   const hist = UrlFetchApp.fetch('https://slack.com/api/conversations.history', {
//     method: 'post',
//     headers: { Authorization: 'Bearer ' + CONF.SLACK_BOT_TOKEN },
//     payload: { channel, latest: ts, inclusive: true, limit: 1 },
//     muteHttpExceptions: true,
//   });
//   const h = JSON.parse(hist.getContentText() || '{}');
//   if (!h.ok) throw new Error('history error: ' + hist.getContentText());

//   let blocks = (h.messages?.[0]?.blocks) || [];
//   blocks = blocks.filter(b => b.type !== 'actions'); // ボタン除去
//   blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statusLine }] }); // 処理結果追記

//   const upd = UrlFetchApp.fetch('https://slack.com/api/chat.update', {
//     method: 'post',
//     headers: { Authorization: 'Bearer ' + CONF.SLACK_BOT_TOKEN },
//     payload: { channel, ts, text: statusLine, blocks: JSON.stringify(blocks) },
//     muteHttpExceptions: true,
//   });
//   const u = JSON.parse(upd.getContentText() || '{}');
//   if (!u.ok) throw new Error('chat.update failed: ' + upd.getContentText());
// }

/** 追記（処理ログ行をcontextで追加） */
// function appendNoteToSlack_(channel, ts, noteLine) {
//   const hist = UrlFetchApp.fetch('https://slack.com/api/conversations.history', {
//     method: 'post',
//     headers: { Authorization: 'Bearer ' + CONF.SLACK_BOT_TOKEN },
//     payload: { channel, latest: ts, inclusive: true, limit: 1 },
//     muteHttpExceptions: true,
//   });
//   const h = JSON.parse(hist.getContentText() || '{}');
//   if (!h.ok) throw new Error('history error: ' + hist.getContentText());

//   const msg = (h.messages || [])[0] || {};
//   const blocks = (msg.blocks || []).concat([{ type: 'context', elements: [{ type: 'mrkdwn', text: noteLine }] }]);

//   const upd = UrlFetchApp.fetch('https://slack.com/api/chat.update', {
//     method: 'post',
//     headers: { Authorization: 'Bearer ' + CONF.SLACK_BOT_TOKEN },
//     payload: { channel, ts, text: noteLine, blocks: JSON.stringify(blocks) },
//     muteHttpExceptions: true,
//   });
//   const u = JSON.parse(upd.getContentText() || '{}');
//   if (!u.ok) throw new Error('chat.update error: ' + upd.getContentText());
// }


/** NG理由モーダル */
function openNgModal_(triggerId, val, channel, ts, responseUrl, baseBlocks) {
  const view = {
    type: 'modal',
    callback_id: 'ng_modal',
    title:  { type: 'plain_text', text: 'NG理由' },
    submit: { type: 'plain_text', text: '送信' },
    close:  { type: 'plain_text', text: 'キャンセル' },
    // ★ 後で必要な情報を丸ごと入れる
    private_metadata: JSON.stringify({
      name: val.name,
      path: val.path,
      channel,
      ts,
      responseUrl,
      blocks: baseBlocks
    }),
    blocks: [
      {
        type: 'input',
        block_id: 'reason_block',
        label: { type: 'plain_text', text: 'NG理由（選択）' },
        element: {
          type: 'static_select',
          action_id: 'reason_select',
          placeholder: { type: 'plain_text', text: '選択してください' },
          options: [
            { text: { type: 'plain_text', text: '不適切な内容' }, value: 'inappropriate' },
            { text: { type: 'plain_text', text: '肖像権・著作権の懸念' }, value: 'rights' },
            { text: { type: 'plain_text', text: '画質/縦横比が基準外' }, value: 'quality' },
            { text: { type: 'plain_text', text: '重複アップロード' }, value: 'duplicate' },
            { text: { type: 'plain_text', text: 'その他' }, value: 'other' },
          ]
        }
      },
      {
        type: 'input',
        block_id: 'reason_block2',
        optional: true,
        label: { type: 'plain_text', text: '補足（任意）' },
        element: { type: 'plain_text_input', action_id: 'reason_text', multiline: true,
          placeholder: { type: 'plain_text', text: '詳細やメモを入力' } }
      }
    ]
  };

  UrlFetchApp.fetch('https://slack.com/api/views.open', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + CONF.SLACK_BOT_TOKEN },
    payload: { trigger_id: triggerId, view: JSON.stringify(view) },
    muteHttpExceptions: true,
  });
}


/** 監査ログ（1行追記） */
// function logSheet_({ action, reason, name, dropboxPath, slackUser, slackTs, driveId, driveUrl }) {
//   const sh = SpreadsheetApp.openById(CONF.SHEET_ID).getSheets()[0];
//   sh.appendRow([
//     new Date(), action || '', reason || '', name || '', dropboxPath || '',
//     '', // uploader_email（必要なら拡張）
//     '', // size（必要なら拡張）
//     slackUser || '', slackTs || '',
//     driveId || '', driveUrl || '',
//     ''  // notes
//   ]);
// }

/** Slack用：最低限のエスケープ */
function escapeMrkdwn_(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** 手動テスト用（任意） */
function testPostDummy_() {
  postNewPhotoToSlack_(
    { name: 'sample.jpg', path_lower: '/inbox/sample.jpg' },
    'https://via.placeholder.com/800x450.png?text=Preview'
  );
}

function selfCheckOnce() {
  const errors = [];

  // Drive
  try {
    const f = DriveApp.getFolderById(CONF.DRIVE_OK_FOLDER_ID);
    const test = Utilities.newBlob('ping','text/plain','ok.txt');
    const file = f.createFile(test);
    file.setTrashed(true);
  } catch (e) {
    errors.push('Drive: フォルダID不正 or 権限不足（DRIVE_OK_FOLDER_ID）');
  }

  // Sheet
  try {
    const ss = SpreadsheetApp.openById(CONF.SHEET_ID);
    const sh = ss.getSheets()[0];
    sh.appendRow([new Date(), 'SELF-CHECK', 'OK']);
  } catch (e) {
    errors.push('Sheet: シートID不正 or 権限不足（SHEET_ID）');
  }

  // Dropbox
  try {
    const token = getDropboxAccessToken_();
    const res = UrlFetchApp.fetch('https://api.dropboxapi.com/2/files/list_folder', {
      method:'post', contentType:'application/json', headers:{Authorization:'Bearer '+token},
      payload: JSON.stringify({ path: CONF.DBX_INBOX_PATH, recursive:false })
    });
    const code = res.getResponseCode();
    if (code !== 200) errors.push('Dropbox: list_folder 失敗 ' + code + ' ' + res.getContentText());
  } catch (e) {
    errors.push('Dropbox: token or list_folder エラー ' + e);
  }

  if (errors.length) {
    throw new Error('SELF-CHECK NG:\n- ' + errors.join('\n- '));
  }
}

// response_urlで、元メッセージを即時更新（ボタン削除も可）
function replaceOriginalViaResponseUrl_(responseUrl, baseBlocks, statusLine, removeActions) {
  // blocksを生成
  let blocks = JSON.parse(JSON.stringify(baseBlocks || []));
  if (removeActions) {
    blocks = blocks.filter(b => b.type !== 'actions');
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: statusLine }] });

  const resp = UrlFetchApp.fetch(responseUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      replace_original: true,
      text: statusLine,          // フォールバック
      blocks: blocks
    }),
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('response_url update failed: ' + code + ' ' + resp.getContentText());
  }
}

/** スプシ記録（失敗しても全体を落とさない安全版） */
function logSheetSafe_({ action, reason, name, dropboxPath, slackUser, slackTs, driveId, driveUrl }) {
  try {
    const ss = SpreadsheetApp.openById(CONF.SHEET_ID);
    const sh = ss.getSheets()[0];

    // 見出しが無ければ作成
    if (sh.getLastRow() === 0) {
      sh.appendRow([
        'timestamp','action','reason','name','dropboxPath',
        'uploader_email','size','slackUser','slackTs','driveId','driveUrl','notes'
      ]);
    }

    sh.appendRow([
      new Date(), action || '', reason || '', name || '', dropboxPath || '',
      '', '', slackUser || '', slackTs || '', driveId || '', driveUrl || '', ''
    ]);
  } catch (e) {
    // ここで例外を握りつぶして、OK/NG全体の処理を止めない
    // 必要なら、Slack側へエラー通知する処理を足してOK
    // 例：appendNoteToSlack_(CONF.SLACK_CHANNEL_ID, someTs, `⚠️ スプシ記録エラー: ${escapeMrkdwn_(String(e))}`);
  }
}

function enqueueNgJob_(job) {
  const key = 'NGJOB_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(job));
  ScriptApp.newTrigger('runNgJobs_').timeBased().after(200).create(); // すぐ実行
}

function runNgJobs_() {
  const sp = PropertiesService.getScriptProperties();
  const all = sp.getProperties();
  Object.keys(all).filter(k => k.startsWith('NGJOB_')).forEach(k => {
    const job = JSON.parse(all[k] || '{}');
    try {
      // 進捗
      replaceOriginalViaResponseUrl_(job.responseUrl, job.blocks,`⏳ NG処理開始 by <@${job.userId}>`, false);

      // 本処理（Dropbox→→DriveのNGフォルダへコピー）
      const info = handleNGCopyToDrive_(job.path, job.name);

      // 完了＋ボタン削除
      replaceOriginalViaResponseUrl_(job.responseUrl, job.blocks,
        `🛑 非承認（<@${job.userId}>：${escapeMrkdwn_(job.reason)}） → <${info.webViewLink}|NGフォルダに保存>`, true);

      // スプシ
      logSheetSafe_({
        action:'NG', reason:job.reason, name:job.name, dropboxPath:job.path,
        slackUser:job.userId, slackTs:job.ts, driveId:info.fileId, driveUrl:info.webViewLink
      });
    } catch (e) {
      // 失敗表示（ボタンは残す）
      try {
        replaceOriginalViaResponseUrl_(job.responseUrl, job.blocks,
          `⚠️ NG処理エラー: ${escapeMrkdwn_(String(e))}`, false);
      } catch (_) {}
    } finally {
      sp.deleteProperty(k);
    }
  });
}

function run_longpoll_now() {
  longpollDropbox_();
}

function longpollDropbox_() {
  let cursor = PropertiesService.getScriptProperties().getProperty(CONF.DBX_CURSOR_KEY);
  if (!cursor) {
    initDropboxCursor();
    cursor = PropertiesService.getScriptProperties().getProperty(CONF.DBX_CURSOR_KEY);
  }

  // 30秒ブロッキングで変更待ち（GASでもOK）
  const resp = UrlFetchApp.fetch('https://notify.dropboxapi.com/2/files/list_folder/longpoll', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ cursor, timeout: 30 }), // timeout は最大30（GASに適する）
    muteHttpExceptions: true
  });
  const data = JSON.parse(resp.getContentText() || '{}');

  // 変化があれば差分取得＆Slack通知
  if (data.changes === true) {
    pollDropboxInbox(); // ←あなたの既存関数（continue→Slack投稿）
  }
}

/** Dropbox Webhook: verification (GET challenge) */
function doGet(e) {
  try {
    // すべて丸見えログ
    // paperLog_(`[DBX][GET] headers=${JSON.stringify(e && e.headers || {})}`);
    // paperLog_(`[DBX][GET] params=${JSON.stringify(e && e.parameter || {})}`);
    // paperLog_(`[DBX][GET] queryString=${JSON.stringify(e && e.queryString || '')}`);

    // challenge が来ていれば、その「文字列そのもの」を返す（引用符や空白を足さない）
    const challenge = e && e.parameter && e.parameter.challenge;
    if (challenge) {
//      paperLog_(`[DBX][GET] challenge received len=${String(challenge).length}`);
      return ContentService.createTextOutput(String(challenge)).setMimeType(ContentService.MimeType.TEXT); // ← text/plain が必要
    }

    // それ以外は疎通確認
    return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    paperLog_(`[DBX][GET] ERROR ${err && (err.stack || err)}`);
    return ContentService.createTextOutput('error').setMimeType(ContentService.MimeType.TEXT);
  }
}

/** Dropbox Webhook 署名検証 */
function verifyDbxWebhook_(e) {
  try {
    const sig = e.headers['X-Dropbox-Signature'] || e.headers['x-dropbox-signature'];
    if (!sig) return false;
    const body =
      (e.postData && e.postData.getDataAsString ? e.postData.getDataAsString() : (e.postData && e.postData.contents)) || '';
    const mac = Utilities.computeHmacSha256Signature(body, CONF.DBX_APP_SECRET);
    const hex = mac.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
    return Utilities.computeSecureSignature(hex) === Utilities.computeSecureSignature(sig);
  } catch (_) { return false; }
}

/** Dropbox Webhook 本体（処理は既存のpollを再利用） */
function handleDropboxWebhook_(e) {
  // 連続通知のデバウンス（必要に応じて調整）
  const lock = LockService.getScriptLock();
  try { lock.tryLock(500); } catch (_) {}
  try {
    const last = Number(SP.getProperty('DBX_WEBHOOK_LAST_TS') || '0');
    const now  = Date.now();
    if (now - last < 1500) {
      paperLog_(`[DBX][POST] debounced (last=${last}, now=${now})`);
      return;
    }
    SP.setProperty('DBX_WEBHOOK_LAST_TS', String(now));

    paperLog_(`[DBX][POST] calling pollDropboxInbox()`);
    pollDropboxInbox();
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function paperLog_() {
  try {
    const id = PropertiesService.getScriptProperties().getProperty('DEBUG_SHEET_ID');
    if (!id) {
      // DEBUG_SHEET_ID が未設定ならログは無視（動作継続）
      return;
    }
    const ss = SpreadsheetApp.openById(id);
    const sh = ss.getSheets()[0];

    // 引数を全部連結
    const msg = Array.from(arguments)
      .map(v => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(' ');

    sh.appendRow([new Date(), msg]);
  } catch (err) {
    // ログ書き込みに失敗しても無視
    console.warn('paperLog_ failed:', err);
  }
}

