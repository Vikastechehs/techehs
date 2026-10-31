(function () {
  const $ = (id) => document.getElementById(id);
  const credentials = () => ({ email: $('email').value, license_key: $('key').value.trim() });
  const message = (text, error = false) => { $('message').textContent = text; $('message').className = error ? 'error' : 'muted'; };
  async function call(action, extra = {}) {
    const response = await fetch('api/manage/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...credentials(), ...extra }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }
  function render(account) {
    $('account').hidden = false; message('');
    const date = account.expires_at ? new Date(account.expires_at).toLocaleDateString() : 'unknown';
    $('status').textContent = account.status === 'active' ? 'Pro is active' : account.status === 'disabled' ? 'This license is disabled. Contact support.' : 'This subscription has ended';
    $('period').textContent = account.status !== 'active' ? `Ended ${date}.` : account.renewal_cancelled ? `Renewal cancelled. Pro remains active until ${date}.` : `Renews on ${date}.`;
    $('usage').textContent = `${account.instances.length} of ${account.activation_limit} activations used.`;
    $('instances').replaceChildren(...account.instances.map((instance) => {
      const item = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
      label.textContent = `${instance.name} · activated ${new Date(instance.created_at).toLocaleDateString()}`;
      button.type = 'button'; button.className = 'secondary'; button.textContent = 'Release';
      button.addEventListener('click', () => run('release', { instance_id: instance.id }));
      item.append(label, button); return item;
    }));
    $('cancel').hidden = account.status !== 'active' || account.renewal_cancelled;
  }
  async function run(action, extra) {
    try { render(await call(action, extra)); } catch (error) { message(error.message, true); }
  }
  $('form').addEventListener('submit', (event) => { event.preventDefault(); run('status'); });
  $('cancel').addEventListener('click', () => { if (confirm('Stop future renewals? Pro stays active until the end of the paid period.')) run('cancel'); });
})();
