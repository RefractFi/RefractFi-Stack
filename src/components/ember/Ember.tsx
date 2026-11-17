import React from 'react';
import {useEffect, useRef} from 'react';
import {EmberEngine} from './engine';
import './ember.css';

export default function Ember() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const r = root.current!;
    const engine = new EmberEngine(r, r.querySelector('.em-gl')!, r.querySelector('.em-hit')!);
    return () => engine.destroy();
  }, []);
  return (
    <div ref={root} className="em">
      <canvas className="em-gl" aria-hidden="true" />
      <button className="em-hit" type="button" role="switch" aria-checked="false" aria-label="Night theme. Switch to day" />
    </div>
  );
}
