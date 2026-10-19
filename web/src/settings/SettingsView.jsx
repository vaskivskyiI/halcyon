import { useEffect, useState } from 'react';
import { User, Sparkles, Mail, Calendar, Filter, Tag, FileText, Palette, Shield, Info, Users as UsersIcon, Bell } from 'lucide-react';
import { store } from '../store.js';
import { navigate } from '../util.js';
import Accounts from './Accounts.jsx';
import AISettings from './AISettings.jsx';
import Rules from './Rules.jsx';
import { MailPrefs, CalendarPrefs, Appearance, Notifications, Templates, Labels, Security, AdminUsers, About } from './Prefs.jsx';

const SECTIONS = [
  ['accounts', User, 'Accounts'], ['ai', Sparkles, 'AI & assistant'], ['mail', Mail, 'Mail'], ['notifications', Bell, 'Notifications'],
  ['calendar', Calendar, 'Calendar'], ['rules', Filter, 'Rules'], ['labels', Tag, 'Labels'], ['templates', FileText, 'Templates'],
  ['appearance', Palette, 'Appearance'], ['security', Shield, 'Security'], ['users', UsersIcon, 'Users', true], ['about', Info, 'About & shortcuts'],
];

export default function SettingsView({ route }) {
  const section = route[1] || 'accounts';
  const user = store.use((s) => s.user);
  const C = { accounts: Accounts, ai: AISettings, mail: MailPrefs, notifications: Notifications, calendar: CalendarPrefs, rules: Rules, labels: Labels, templates: Templates, appearance: Appearance, security: Security, users: AdminUsers, about: About }[section] || Accounts;
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
          {SECTIONS.map(([id, , label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <C />
      </div>
    </div>
  );
}
