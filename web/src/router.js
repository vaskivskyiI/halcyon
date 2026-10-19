import { useEffect, useState } from 'react';

export function useRoute() {
  const parse = () => location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent).filter((x, i) => x || i === 0);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
