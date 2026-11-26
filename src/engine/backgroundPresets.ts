import type { BackgroundPresetId } from './types';

export interface BackgroundPresetMeta {
  id: BackgroundPresetId;
  name: string;
  shortDesc: string;
  previewGradient: string;
  isDark: boolean;
}

export const BACKGROUND_PRESETS: BackgroundPresetMeta[] = [
  {
    id: 'cozy-rain-cafe',
    name: 'Quán Cà Phê Mưa Ấm',
    shortDesc: 'Cửa kính mưa rơi & ánh đèn vàng dịu (kiểu YouTube luyện nghe)',
    previewGradient: 'linear-gradient(160deg, #1E1B2E 0%, #3B2820 55%, #78350F 100%)',
    isDark: true,
  },
  {
    id: 'night-study-desk',
    name: 'Bàn Học Đèn Vàng Đêm',
    shortDesc: 'Không gian học tập ban đêm tĩnh lặng, hạt sáng nhẹ',
    previewGradient: 'linear-gradient(160deg, #0F172A 0%, #1E293B 55%, #312E81 100%)',
    isDark: true,
  },
  {
    id: 'midnight-city-lofi',
    name: 'Phố Đêm Lofi Mưa Nhẹ',
    shortDesc: 'Cửa sổ thành phố ban đêm với ánh đèn bokeh mờ ảo',
    previewGradient: 'linear-gradient(160deg, #090D16 0%, #172554 55%, #4C1D95 100%)',
    isDark: true,
  },
  {
    id: 'misty-forest-dusk',
    name: 'Rừng Sương Chiều Tĩnh',
    shortDesc: 'Đồi núi sương mờ xanh dịu giúp mắt thư giãn',
    previewGradient: 'linear-gradient(160deg, #0F292E 0%, #134E4A 52%, #1E3A3A 100%)',
    isDark: true,
  },
  {
    id: 'zen-botanical-room',
    name: 'Phòng Nắng & Bóng Lá',
    shortDesc: 'Ánh nắng chiều qua cửa sổ và bóng lá đung đưa nhẹ',
    previewGradient: 'linear-gradient(160deg, #27221E 0%, #44403C 50%, #3F6212 100%)',
    isDark: true,
  },
  {
    id: 'warm-sunset-paper',
    name: 'Hoàng Hôn Dịu Nhẹ',
    shortDesc: 'Ánh chiều tà ấm áp chuyển màu êm ái cho bài đọc dài',
    previewGradient: 'linear-gradient(160deg, #2E1065 0%, #7C2D12 55%, #B45309 100%)',
    isDark: true,
  },
];

function seededNoise(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Deterministic animated canvas backdrop inspired by calm YouTube language-study ambience videos.
 * Renders identically in real-time preview and offline frame-by-frame MP4 export.
 */
export function drawPresetBackground(
  ctx: CanvasRenderingContext2D,
  presetId: BackgroundPresetId | string,
  width: number,
  height: number,
  timeSec = 0,
): void {
  const t = Number.isFinite(timeSec) ? timeSec : 0;
  ctx.save();

  switch (presetId) {
    case 'cozy-rain-cafe': {
      const grad = ctx.createLinearGradient(0, 0, width * 0.35, height);
      grad.addColorStop(0, '#13111C');
      grad.addColorStop(0.55, '#271C19');
      grad.addColorStop(1, '#3D2618');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Warm window bokeh orbs
      const orbs = [
        { x: 0.22, y: 0.28, r: 0.24, c: 'rgba(245, 158, 11, 0.16)', sp: 0.35 },
        { x: 0.78, y: 0.38, r: 0.28, c: 'rgba(251, 146, 60, 0.14)', sp: -0.25 },
        { x: 0.5, y: 0.72, r: 0.32, c: 'rgba(217, 119, 6, 0.12)', sp: 0.2 },
      ];
      const minDim = Math.min(width, height);
      for (const orb of orbs) {
        const ox = width * orb.x + Math.sin(t * orb.sp) * 28;
        const oy = height * orb.y + Math.cos(t * orb.sp * 0.8) * 18;
        const g = ctx.createRadialGradient(ox, oy, 10, ox, oy, minDim * orb.r);
        g.addColorStop(0, orb.c);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      // Soft falling rain streaks
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.16)';
      ctx.lineWidth = Math.max(1.2, width * 0.0014);
      for (let i = 0; i < 42; i++) {
        const rx = seededNoise(i + 1) * width;
        const speed = 220 + seededNoise(i + 50) * 180;
        const ry = ((seededNoise(i + 100) * height + t * speed) % (height + 120)) - 60;
        const len = 18 + seededNoise(i + 150) * 28;
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx - len * 0.16, ry + len);
        ctx.stroke();
      }
      break;
    }

    case 'night-study-desk': {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#0B1120');
      grad.addColorStop(0.55, '#172033');
      grad.addColorStop(1, '#1E1B4B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Desk lamp cone glow
      const lampX = width * 0.5 + Math.sin(t * 0.3) * 18;
      const lampY = height * 0.16;
      const cone = ctx.createRadialGradient(lampX, lampY, 20, width * 0.5, height * 0.52, Math.max(width, height) * 0.72);
      cone.addColorStop(0, 'rgba(253, 224, 71, 0.18)');
      cone.addColorStop(0.45, 'rgba(99, 102, 241, 0.10)');
      cone.addColorStop(1, 'rgba(15, 23, 42, 0)');
      ctx.fillStyle = cone;
      ctx.fillRect(0, 0, width, height);

      // Gentle drifting dust motes
      for (let i = 0; i < 28; i++) {
        const dx = (seededNoise(i + 201) * width + Math.sin(t * 0.4 + i) * 35 + width) % width;
        const dy = ((seededNoise(i + 301) * height - t * (12 + seededNoise(i + 401) * 14)) % height + height) % height;
        const r = 1.5 + seededNoise(i + 501) * 3.2;
        ctx.fillStyle = `rgba(253, 230, 138, ${(0.14 + 0.14 * Math.sin(t + i)).toFixed(2)})`;
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case 'midnight-city-lofi': {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#070B19');
      grad.addColorStop(0.55, '#141E46');
      grad.addColorStop(1, '#2B184B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Soft skyline silhouettes
      ctx.fillStyle = 'rgba(10, 15, 32, 0.72)';
      const bCount = 14;
      const bw = width / bCount;
      for (let i = 0; i < bCount; i++) {
        const bh = height * (0.14 + seededNoise(i + 12) * 0.22);
        ctx.fillRect(i * bw - 2, height - bh, bw + 4, bh);
      }

      // Blurred neon & warm window lights
      const minD = Math.min(width, height);
      for (let i = 0; i < 18; i++) {
        const bx = seededNoise(i + 71) * width;
        const by = height * (0.38 + seededNoise(i + 81) * 0.52);
        const br = minD * (0.04 + seededNoise(i + 91) * 0.08);
        const pulse = 0.65 + 0.35 * Math.sin(t * 0.8 + i * 1.3);
        const color = i % 3 === 0 ? `rgba(251, 191, 36, ${(0.14 * pulse).toFixed(3)})` : i % 3 === 1 ? `rgba(56, 189, 248, ${(0.13 * pulse).toFixed(3)})` : `rgba(192, 132, 252, ${(0.12 * pulse).toFixed(3)})`;
        const g = ctx.createRadialGradient(bx, by, 2, bx, by, br);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(bx - br, by - br, br * 2, br * 2);
      }
      break;
    }

    case 'misty-forest-dusk': {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#0B2027');
      grad.addColorStop(0.5, '#133B3F');
      grad.addColorStop(1, '#1B4332');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Soft sunbeams from top-left
      const beam = ctx.createRadialGradient(width * 0.25, height * 0.14, 15, width * 0.45, height * 0.45, Math.max(width, height) * 0.8);
      beam.addColorStop(0, 'rgba(167, 243, 208, 0.20)');
      beam.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = beam;
      ctx.fillRect(0, 0, width, height);

      // Layered misty ridges
      const ridgeColors = ['rgba(15, 42, 46, 0.55)', 'rgba(17, 56, 52, 0.68)', 'rgba(11, 37, 34, 0.82)'];
      ridgeColors.forEach((rc, rIdx) => {
        ctx.fillStyle = rc;
        ctx.beginPath();
        const baseY = height * (0.58 + rIdx * 0.12);
        ctx.moveTo(0, height);
        for (let x = 0; x <= width; x += Math.max(24, width / 24)) {
          const wave = Math.sin(x * 0.004 + rIdx * 1.9 + t * 0.08 * (rIdx + 1)) * (height * 0.035);
          ctx.lineTo(x, baseY + wave);
        }
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();
      });
      break;
    }

    case 'zen-botanical-room': {
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, '#1F2421');
      grad.addColorStop(0.55, '#2C3639');
      grad.addColorStop(1, '#3F4E4F');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Warm diagonal sunlight strips through blinds
      ctx.save();
      ctx.translate(width * 0.5, height * 0.4);
      ctx.rotate(-0.22);
      for (let s = -2; s <= 2; s++) {
        const sy = s * height * 0.16 + Math.sin(t * 0.35 + s) * 8;
        ctx.fillStyle = 'rgba(254, 243, 199, 0.065)';
        ctx.fillRect(-width, sy, width * 2, height * 0.085);
      }
      ctx.restore();

      // Gentle swaying leaf silhouettes on corners
      ctx.fillStyle = 'rgba(15, 28, 22, 0.45)';
      for (let i = 0; i < 6; i++) {
        const sway = Math.sin(t * 0.6 + i * 0.9) * 14;
        ctx.beginPath();
        ctx.ellipse(width * (0.08 + i * 0.04) + sway, height * (0.18 + i * 0.06), width * 0.14, height * 0.035, 0.4 + i * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }

    case 'warm-sunset-paper':
    default: {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#1E1B4B');
      grad.addColorStop(0.42, '#6D28D9');
      grad.addColorStop(0.76, '#C2410C');
      grad.addColorStop(1, '#F59E0B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);

      // Soft horizon sun halo
      const sunX = width * 0.5;
      const sunY = height * 0.66 + Math.sin(t * 0.25) * 12;
      const halo = ctx.createRadialGradient(sunX, sunY, 20, sunX, sunY, Math.max(width, height) * 0.55);
      halo.addColorStop(0, 'rgba(254, 240, 138, 0.36)');
      halo.addColorStop(0.5, 'rgba(251, 146, 60, 0.18)');
      halo.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, width, height);
      break;
    }
  }

  ctx.restore();
}
