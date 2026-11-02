import { useEffect, useState } from 'react';
import { User, Sparkles, Mail, Calendar, Filter, Tag, FileText, Palette, Shield, Info, Users as UsersIcon, Bell, Layers, Activity, Share2, Plug, Archive, CalendarCog, Puzzle, Cpu } from 'lucide-react';
import { store } from '../store.js';
import { navigate } from '../util.js';
import Accounts from './Accounts.jsx';
import AISettings from './AISettings.jsx';
import Rules from './Rules.jsx';
import Spaces from './Spaces.jsx';
import Sharing from './Sharing.jsx';
import Assistants from './Assistants.jsx';
import Integrations from './Integrations.jsx';
import Archives from './Archives.jsx';
import CalendarsTasks from './CalendarsTasks.jsx';
import ServerActivity from './ServerActivity.jsx';
import { MailPrefs, CalendarPrefs, Appearance, Notifications, Templates, Labels, Security, AdminUsers, About, Diagnostics } from './Prefs.jsx';

const SECTIONS = [
  ['accounts', User, 'Accounts'], ['spaces', Layers, 'Spaces'], ['sharing', Share2, 'Sharing'], ['ai', Sparkles, 'AI & assistant'], ['assistants', Plug, 'Assistants (MCP)'], ['integrations', Puzzle, 'Integrations'], ['mail', Mail, 'Mail'], ['archives', Archive, 'Archives'], ['notifications', Bell, 'Notifications'],
  ['calendar', Calendar, 'Calendar'], ['calendars', CalendarCog, 'Calendars & tasks'], ['rules', Filter, 'Rules'], ['labels', Tag, 'Labels'], ['templates', FileText, 'Templates'],
  ['appearance', Palette, 'Appearance'], ['security', Shield, 'Security'], ['diagnostics', Activity, 'Diagnostics'], ['users', UsersIcon, 'Users', true], ['server', Cpu, 'Server activity', true], ['about', Info, 'About & shortcuts'],
];

export default function SettingsView({ route }) {
  const section = route[1] || 'accounts';
  const user = store.use((s) => s.user);
  const acting = store.use((s) => s.acting);
  // In a shared space its settings are set once by its owners; one's own look, notifications and mail habits stay free.
  const ownerOnly = acting && acting.role !== 'owner' && !['appearance', 'notifications', 'sharing', 'assistants', 'integrations', 'security', 'about', 'mail'].includes(section);
  const C = { accounts: Accounts, spaces: Spaces, sharing: Sharing, ai: AISettings, assistants: Assistants, integrations: Integrations, mail: MailPrefs, archives: Archives, notifications: Notifications, calendar: CalendarPrefs, calendars: CalendarsTasks, rules: Rules, labels: Labels, templates: Templates, appearance: Appearance, security: Security, diagnostics: Diagnostics, users: AdminUsers, server: ServerActivity, about: About }[section] || Accounts;
  return (
    <div className="settings">
      <nav className="settings-nav">
        <h3 style={{ margin: '4px 10px 12px' }}>Settings</h3>
        {SECTIONS.filter(([, , , admin]) => !admin || user.isAdmin).map(([id, Icon, label]) => (
          <div key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => navigate(`#/settings/${id}`)}><Icon size={16} /> {label}</div>
        ))}
      </nav>
      <div className="settings-body">
        <select className="input mobile-only" style={{ marginBottom: 16, display: undefined }} value={section} onChange={(e) => navigate(`#/settings/${e.target.value}`)}>
          {SECTIONS.filter(([, , , admin]) => !admin || user.isAdmin).map(([id, , label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        {ownerOnly && <div className="notice" style={{ marginTop: 0 }}>These settings belong to the shared space “{acting.name}” and are set once by its owners for everyone in it — you can look, not change them.</div>}
        {acting && section === 'mail' && <div className="notice" style={{ marginTop: 0 }}>In “{acting.name}”: undo send, remote images, marking as read, the compose format and reply-all are your own; the rest is set once by the space's owners.</div>}
        <C />
      </div>
    </div>
  );
}
