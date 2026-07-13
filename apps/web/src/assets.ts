import token1 from "./assets/images/p1.png";
import token2 from "./assets/images/p2.png";
import token3 from "./assets/images/p3.png";
import token4 from "./assets/images/p4.png";
import token5 from "./assets/images/p5.png";
import token6 from "./assets/images/p6.png";
import railroadArtwork from "./assets/images/rails.png";
import electricityArtwork from "./assets/images/elects.png";
import waterArtwork from "./assets/images/water.png";
import chanceArtwork from "./assets/images/chance.png";
import chestArtwork from "./assets/images/chest.png";
import jailArtwork from "./assets/images/jail.png";
import buyingSound from "./assets/audio/buying.mp3";
import cardSound from "./assets/audio/card.mp3";
import jailSound from "./assets/audio/jail.mp3";
import notificationSound from "./assets/audio/notifications.mp3";
import rollingSound from "./assets/audio/rolling.mp3";
import winningSound from "./assets/audio/winning.mp3";

export const artwork = { railroad: railroadArtwork, electricity: electricityArtwork, water: waterArtwork, chance: chanceArtwork, chest: chestArtwork, jail: jailArtwork };

// GameEngine assigns icons from zero. The source artwork starts at p1, so icon
// zero (the first admitted player) intentionally renders p1.png.
export const playerTokens = [token1, token2, token3, token4, token5, token6];

const sounds = {
  buy: buyingSound,
  card: cardSound,
  jail: jailSound,
  notification: notificationSound,
  roll: rollingSound,
  win: winningSound,
};

export function playSound(name: keyof typeof sounds) {
  const audio = new Audio(sounds[name]);
  audio.volume = name === "roll" ? 0.35 : 0.45;
  void audio.play().catch(() => undefined);
}
