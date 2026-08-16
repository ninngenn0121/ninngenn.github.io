// 管理パネルのユーザー一覧を描画する関数
function renderAdminTable(users) {
  const tbody = document.getElementById('admin-user-list');
  if (!tbody) return;
  
  tbody.innerHTML = '';

  users.forEach(user => {
    // IPv6のローカル表記 ::1 を見やすく変換
    let displayIp = user.ip || '未取得';
    if (displayIp === '::1' || displayIp === '::ffff:127.0.0.1') {
      displayIp = '127.0.0.1 (ローカル)';
    } else {
      displayIp = displayIp.replace(/^::ffff:/, '');
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${user.id}</td>
      <td>${user.username || '名前なし'}</td>
      <!-- IPアドレス専用セル（背景色・等幅フォントをインライン指定） -->
      <td style="text-align: center; font-family: monospace, monospace; background-color: #fafafa; white-space: nowrap; font-weight: bold;">
        ${displayIp}
      </td>
      <td>${user.status || 'アクティブ'}</td>
      <td style="text-align: center;">
        <button onclick="banUser('${user.id}')" style="background-color: #ff4d4f; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer;">
          BAN
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}
