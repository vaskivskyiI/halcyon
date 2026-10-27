import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
// The service worker (push notifications); not needed for the app itself.
import('./push.js').then((m) => m.registerWorker()).catch(() => {});
