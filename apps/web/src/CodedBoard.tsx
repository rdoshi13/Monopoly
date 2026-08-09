import type { CSSProperties } from "react";
import { boardSpaces, type BoardSpace, type GameSnapshot } from "@monopoly/game-engine";
import { artwork, playerTokens } from "./assets";

interface CodedBoardProps {
  game: GameSnapshot;
  highlightedPlayerId: string | null;
  animatedToken: { playerId: string; position: number; isInJail: boolean; moving: boolean } | null;
  onSelectProperty: (position: number) => void;
  playerColor: (icon: number) => string;
  propertyName: (position: number) => string;
}

const groupColors: Record<string, string> = {
  Brown: "#955436",
  "Light Blue": "#aae0fa",
  Pink: "#d93a96",
  Orange: "#f7941d",
  Red: "#ed1b24",
  Yellow: "#fef200",
  Green: "#1fb25a",
  "Dark Blue": "#0072bb",
};

/**
 * Break points for the words that cannot fit a board cell on one line. These are
 * soft hyphens, so they only render when the word actually wraps, and they are
 * presentation-only: the engine's canonical names stay unbroken. Automatic
 * hyphenation is not an option because `hyphens: auto` needs a dictionary the
 * browser does not always have, and without one long names break mid-syllable.
 */
const softHyphenatedWords: Record<string, string> = {
  Community: "Com­mu­nity",
  Fenchurch: "Fen­church",
  Liverpool: "Liver­pool",
  Marlborough: "Marl­borough",
  Marylebone: "Maryle­bone",
  Northumberland: "North­umber­land",
  Pentonville: "Penton­ville",
  Whitechapel: "White­chapel",
};
const hyphenate = (name: string) => name.split(" ").map((word) => softHyphenatedWords[word] ?? word).join(" ");

const cornerTrackUnits = 1.6;
const regularTrackUnits = 1;
const boardTrackUnits = (cornerTrackUnits * 2) + (regularTrackUnits * 9);
const cornerSize = (cornerTrackUnits / boardTrackUnits) * 100;
const regularSize = (regularTrackUnits / boardTrackUnits) * 100;

function boardCoordinates(position: number) {
  const cornerCenter = cornerSize / 2;
  const farCornerCenter = 100 - cornerCenter;
  const regularCenter = (index: number) => cornerSize + ((index + 0.5) * regularSize);

  if (position === 0) return { left: farCornerCenter, top: farCornerCenter };
  if (position < 10) return { left: regularCenter(9 - position), top: farCornerCenter };
  if (position === 10) return { left: cornerCenter, top: farCornerCenter };
  if (position < 20) return { left: cornerCenter, top: regularCenter(19 - position) };
  if (position === 20) return { left: cornerCenter, top: cornerCenter };
  if (position < 30) return { left: regularCenter(position - 21), top: cornerCenter };
  if (position === 30) return { left: farCornerCenter, top: cornerCenter };
  return { left: farCornerCenter, top: regularCenter(position - 31) };
}

function tokenCoordinates(position: number, isInJail: boolean) {
  if (position !== 10) return boardCoordinates(position);

  const cornerTop = 100 - cornerSize;
  return isInJail
    ? { left: cornerSize * .62, top: cornerTop + (cornerSize * .38) }
    : { left: cornerSize * .62, top: cornerTop + (cornerSize * .86) };
}

function ownershipRingCoordinates(position: number) {
  const coordinate = boardCoordinates(position);
  const boardInset = 4.5;
  const boardScale = 0.91;
  const boardLeft = boardInset + (coordinate.left * boardScale);
  const boardTop = boardInset + (coordinate.top * boardScale);

  if (position > 0 && position < 10) return { left: `${boardLeft}%`, top: "96.75%", width: "7.45%", height: "2.1%" };
  if (position > 10 && position < 20) return { left: "3.25%", top: `${boardTop}%`, width: "2.1%", height: "7.45%" };
  if (position > 20 && position < 30) return { left: `${boardLeft}%`, top: "3.25%", width: "7.45%", height: "2.1%" };
  if (position > 30 && position < 40) return { left: "96.75%", top: `${boardTop}%`, width: "2.1%", height: "7.45%" };
  return undefined;
}

function gridPlacement(position: number): CSSProperties {
  if (position === 0) return { gridColumn: "12 / span 2", gridRow: "12 / span 2" };
  if (position < 10) return { gridColumn: `${12 - position}`, gridRow: "12 / span 2" };
  if (position === 10) return { gridColumn: "1 / span 2", gridRow: "12 / span 2" };
  if (position < 20) return { gridColumn: "1 / span 2", gridRow: `${22 - position}` };
  if (position === 20) return { gridColumn: "1 / span 2", gridRow: "1 / span 2" };
  if (position < 30) return { gridColumn: `${position - 18}`, gridRow: "1 / span 2" };
  if (position === 30) return { gridColumn: "12 / span 2", gridRow: "1 / span 2" };
  return { gridColumn: "12 / span 2", gridRow: `${position - 28}` };
}

function sideClass(position: number) {
  if (position > 0 && position < 10) return "side-bottom";
  if (position > 10 && position < 20) return "side-left";
  if (position > 20 && position < 30) return "side-top";
  if (position > 30 && position < 40) return "side-right";
  if (position === 20 || position === 30) return "side-top";
  return "side-bottom";
}

function SpecialSpace({ space }: { space: BoardSpace }) {
  if (space.id === "chance") return <><span className="board-space-name">Chance</span><img className="board-space-special-art chance-art" src={artwork.chance} alt="" /></>;
  if (space.id === "communitychest") return <><span className="board-space-name">{hyphenate("Community Chest")}</span><img className="board-space-special-art" src={artwork.chest} alt="" /></>;
  if (space.id === "incometax") return <><span className="board-space-name">{hyphenate(space.name)}</span><span className="board-symbol tax-symbol">◆</span><small>Pay £200</small></>;
  if (space.id === "supertax") return <><span className="board-space-name">{hyphenate(space.name)}</span><span className="board-symbol">💍</span><small>Pay £100</small></>;
  return <span className="board-space-name">{hyphenate(space.name)}</span>;
}

function CornerSpace({ space }: { space: BoardSpace }) {
  if (space.posistion === 0) return <>
    <span className="go-kicker">Collect £200 salary as you pass</span>
    <strong className="go-title">GO</strong>
    <span className="go-arrow" aria-hidden="true">←</span>
  </>;
  if (space.posistion === 10) return <span className="jail-corner-layout">
    <span className="jail-just">Just</span>
    <span className="jail-interior"><img src={artwork.jail} alt="" /><b>In jail</b></span>
    <strong className="jail-visiting">Visiting</strong>
  </span>;
  if (space.posistion === 20) return <span className="corner-diagonal corner-diagonal-parking"><strong className="corner-title"><span>Free</span><span>Parking</span></strong><span className="corner-symbol">🚘</span></span>;
  return <span className="corner-diagonal corner-diagonal-goto"><strong className="corner-title"><span>Go</span><span>To</span><span>Jail</span></strong><span className="corner-symbol">👮</span></span>;
}

function Development({ count }: { count: number | "h" | undefined }) {
  if (count === "h") return <span className="board-hotel" title="Hotel" />;
  if (!count) return null;
  return <span className="board-houses" title={`${count} house${count === 1 ? "" : "s"}`}>{Array.from({ length: count }, (_, index) => <i key={index} />)}</span>;
}

function SpaceContents({ space, development }: { space: BoardSpace; development?: number | "h" }) {
  if (space.group in groupColors) return <>
    <span className="board-color-band" style={{ "--space-color": groupColors[space.group] } as CSSProperties}><Development count={development} /></span>
    <span className="board-space-name">{hyphenate(space.name)}</span>
    <small>£{space.price}</small>
  </>;

  if (space.group === "Railroad") return <>
    <span className="board-space-name">{hyphenate(space.name)}</span>
    <img className="board-space-icon railroad-icon" src={artwork.railroad} alt="" />
    <small>£{space.price}</small>
  </>;

  if (space.group === "Utilities") return <>
    <span className="board-space-name">{hyphenate(space.name)}</span>
    <img className="board-space-icon utility-icon" src={space.id === "waterworks" ? artwork.water : artwork.electricity} alt="" />
    <small>£{space.price}</small>
  </>;

  return <SpecialSpace space={space} />;
}

function BoardSpaceCell({ space, game, onSelectProperty, playerColor }: Pick<CodedBoardProps, "game" | "onSelectProperty" | "playerColor"> & { space: BoardSpace }) {
  const owner = game.players.find((player) => player.properties.some((property) => property.posistion === space.posistion));
  const property = owner?.properties.find((candidate) => candidate.posistion === space.posistion);
  const isCorner = space.posistion % 10 === 0;
  const isPurchasable = space.price !== undefined;
  const isStreet = space.group in groupColors;
  const isSpecial = space.group === "Special";
  const Element = isPurchasable ? "button" : "div";

  return <Element
    className={`coded-space ${sideClass(space.posistion)}${isCorner ? ` corner-space corner-${space.posistion}` : ""}${isStreet ? " street-space" : ""}${isSpecial ? " special-space" : ""}${isPurchasable ? " purchasable" : ""}${property?.mortgaged ? " mortgaged" : ""}`}
    style={{ ...gridPlacement(space.posistion), "--owner-color": owner ? playerColor(owner.icon) : "transparent" } as CSSProperties}
    data-board-position={space.posistion}
    {...(isPurchasable ? { type: "button" as const, onClick: () => onSelectProperty(space.posistion), title: `View ${space.name} property card`, "aria-label": `View property card for ${space.name}` } : {})}
  >
    <span className="board-space-inner">
      {isCorner ? <CornerSpace space={space} /> : <SpaceContents space={space} development={property?.count} />}
      {owner && <i className="space-owner-dot" title={`Owned by ${owner.username}`} />}
    </span>
  </Element>;
}

function tokenOffset(playerCount: number, index: number) {
  const layouts: Record<number, number[][]> = {
    1: [[0, 0]],
    2: [[-36, 0], [36, 0]],
    3: [[0, -38], [-36, 30], [36, 30]],
    4: [[-34, -34], [34, -34], [-34, 34], [34, 34]],
    5: [[-38, -38], [38, -38], [0, 0], [-38, 38], [38, 38]],
    6: [[-52, -34], [0, -34], [52, -34], [-52, 34], [0, 34], [52, 34]],
  };
  return layouts[playerCount]?.[index] ?? [0, 0];
}

export function CodedBoard({ game, highlightedPlayerId, animatedToken, onSelectProperty, playerColor, propertyName }: CodedBoardProps) {
  const displayedPosition = (player: GameSnapshot["players"][number]) => animatedToken?.playerId === player.id ? animatedToken.position : player.position;
  const displayedJailState = (player: GameSnapshot["players"][number]) => animatedToken?.playerId === player.id ? animatedToken.isInJail : player.isInJail;
  return <section className="board-stage" aria-label="Monopoly board and property ownership">
    <div className="ownership-ring" aria-label="Property ownership">
      {game.players.flatMap((player) => player.properties.map((property) => {
        const coordinates = ownershipRingCoordinates(property.posistion);
        if (!coordinates) return null;
        return <span
          className={`ownership-marker${property.mortgaged ? " mortgaged" : ""}`}
          style={{ ...coordinates, "--owner-color": playerColor(player.icon) } as CSSProperties}
          title={`${propertyName(property.posistion)} — ${player.username}${property.mortgaged ? " (mortgaged)" : ""}`}
          aria-label={`${propertyName(property.posistion)} owned by ${player.username}${property.mortgaged ? ", mortgaged" : ""}`}
          key={`${player.id}-${property.posistion}`}
        />;
      }))}
    </div>
    <div className="coded-board">
      {boardSpaces.map((space) => <BoardSpaceCell space={space} game={game} onSelectProperty={onSelectProperty} playerColor={playerColor} key={space.posistion} />)}
      <section className="board-center" aria-hidden="true">
        <div className="board-deck community-deck"><img src={artwork.chest} alt="" /><span>Community Chest</span></div>
        <div className="board-logo"><span>Property trading game</span><strong>MONOPOLY</strong></div>
        <div className="board-deck chance-deck"><img src={artwork.chance} alt="" /><span>Chance</span></div>
      </section>
      <div className="board-token-layer" aria-label="Player locations">
        {game.players.map((player) => {
          const playerPosition = displayedPosition(player);
          const playerIsInJail = displayedJailState(player);
          const playersOnSpace = game.players.filter((candidate) => displayedPosition(candidate) === playerPosition && (playerPosition !== 10 || displayedJailState(candidate) === playerIsInJail));
          const indexOnSpace = playersOnSpace.findIndex((candidate) => candidate.id === player.id);
          const offset = tokenOffset(playersOnSpace.length, indexOnSpace);
          const coordinate = tokenCoordinates(playerPosition, playerIsInJail);
          const isMoving = animatedToken?.playerId === player.id && animatedToken.moving;
          return <span className={`board-token${playerPosition === 10 ? playerIsInJail ? " jail-token" : " visiting-token" : ""}${highlightedPlayerId === player.id ? " highlighted" : ""}${isMoving ? " moving" : ""}`} title={`${player.username}: ${propertyName(playerPosition)}`} style={{ left: `${coordinate.left}%`, top: `${coordinate.top}%`, "--token-offset-x": `${offset[0]}%`, "--token-offset-y": `${offset[1]}%`, "--player-color": playerColor(player.icon) } as CSSProperties} key={player.id}>
            <img src={playerTokens[player.icon] ?? playerTokens[0]} alt={`${player.username} token`} key={isMoving ? playerPosition : "stationary"} />
          </span>;
        })}
      </div>
    </div>
  </section>;
}
