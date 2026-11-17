import {useEffect, useRef} from 'react';
import {LodestoneEngine} from './engine';
import './lodestone.css';

export default function Lodestone() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = root.current!;
    const engine = new LodestoneEngine(r, r.querySelector('.ld-gl')!, r.querySelector('.ld-hit')!);
    return () => engine.destroy();
  }, []);
  return (
    <div ref={root} className="ld">
      <canvas className="ld-gl" aria-hidden="true" />
      <button className="ld-hit" type="button" role="switch" aria-checked="false" aria-label="After dark: off. Switch it on" />
    </div>
  );
}
