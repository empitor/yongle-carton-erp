import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './theme.css';
import './ui/list-layout.css';
import './fulfillment.css';
import './business-export.css';
import './ui-audit.css';
import './ui-upgrade.css';
import { loadTheme } from './theme';
loadTheme();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
