import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import { installOpenGuard } from './opening.js';
import { installAddressCopy } from './addrcopy.js';

// Shown beside another app of the suite (components/SidePane.jsx): no second left menu.
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embedded');
installOpenGuard();
installAddressCopy();
createRoot(document.getElementById('root')).render(<App />);
// The service worker (push notifications); not needed for the app itself.
import('./push.js').then((m) => m.registerWorker()).catch(() => {});
