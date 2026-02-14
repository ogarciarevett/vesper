import { useRef, useEffect, useState } from 'react';
import { Application, Graphics } from 'pixi.js';

export function GameView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || appRef.current) return;

    const initPixi = async () => {
      const app = new Application();
      
      await app.init({ 
        background: '#1a1a1a',
        resizeTo: containerRef.current!,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1,
      });

      if (containerRef.current) {
         containerRef.current.appendChild(app.canvas);
         appRef.current = app;
         setIsReady(true);
         drawIsometricGrid(app);
      }
    };

    initPixi();

    return () => {
      if (appRef.current) {
        appRef.current.destroy(true, { children: true, texture: true });
        appRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden border border-white/10 relative">
       {!isReady && <div className="absolute inset-0 flex items-center justify-center text-white/40">Initializing Neural Link...</div>}
       <div className="absolute top-4 left-4 pointer-events-none">
          <div className="bg-black/60 backdrop-blur px-3 py-1.5 rounded text-xs text-white/60 font-mono border border-white/10">
            VIEW: ISOMETRIC_01
          </div>
       </div>
    </div>
  );
}

function drawIsometricGrid(app: Application) {
    const graphics = new Graphics();
    const tileWidth = 64;
    const tileHeight = 32;
    const cols = 20;
    const rows = 20;
    
    // Center the grid
    const startX = app.screen.width / 2;
    const startY = app.screen.height / 4;

    for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
            const x = (i - j) * (tileWidth / 2) + startX;
            const y = (i + j) * (tileHeight / 2) + startY;

            // Draw tile outline
            graphics.moveTo(x, y);
            graphics.lineTo(x + tileWidth / 2, y + tileHeight / 2);
            graphics.lineTo(x, y + tileHeight);
            graphics.lineTo(x - tileWidth / 2, y + tileHeight / 2);
            graphics.lineTo(x, y);
            
            // Random color variation for "tech" feel
            const alpha = 0.1 + Math.random() * 0.05;
            graphics.stroke({ width: 1, color: 0xffffff, alpha });
        }
    }

    app.stage.addChild(graphics);
}
