import './style.css';

const params = new URLSearchParams(location.search);

if (params.has('view')) {
  import('./viewer').then((m) => m.runViewer(params));
} else {
  import('./app').then((m) => m.startApp(params));
}
