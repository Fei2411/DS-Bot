import { createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Pressable, View, type GestureResponderEvent } from 'react-native'
import Svg, { ClipPath, Defs, G, LinearGradient, Mask, Path, Rect, Stop } from 'react-native-svg'
import { NavigationContext } from '@react-navigation/native'
import { GRADIENTS, INKS, inkName, isHex } from '../../../../ds-bot/src/client/inks.js'
import { CONFETTI_INKS, FLAT_ORIGIN, MARGIN } from '../../../../ds-bot/src/client/avatar/stage.js'
import { LiveMark as Live, type Look, type Picture, type Pose } from './clock.ts'
import { avatarClock } from './host.ts'
import { paintShapes, type Ink, type Node } from './paint.ts'

// A live mark: the flat art until the mark first moves, then the character's model
// turned and drawn by the avatar engine, from the same pose, so nothing jumps when it
// takes over. A photo moves as a whole. The drawing reaches MARGIN past the mark on each
// side and lets touches through to the mark.

// Whether the marks under it are on screen: the drawer says so for its list.
export const MarksShown = createContext(true)

// On screen: its screen is the one in front (a pushed or covering screen hides the ones
// under it), and anything around it says it is shown.
function useOnScreen(): boolean {
  const shown = useContext(MarksShown)
  const navigation = useContext(NavigationContext)
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true)
  useEffect(() => {
    if (!navigation) return undefined
    setFocused(navigation.isFocused())
    const offFocus = navigation.addListener('focus', () => setFocused(true))
    const offBlur = navigation.addListener('blur', () => setFocused(false))
    return () => { offFocus(); offBlur() }
  }, [navigation])
  return shown && focused
}

type Inks = Record<string, string[]>
// The body's paint in this mode: a gradient's stops, or a color.
export function inkOf(color: string, dark: boolean): string | [number, string][] {
  const gradients = GRADIENTS as unknown as Record<string, [number, string][]>
  if (gradients[color]) return gradients[color]
  if (isHex(color)) return color
  return ((INKS as Inks)[inkName(color)] ?? (INKS as Inks).gray)[dark ? 1 : 0]
}
const confettiOf = (dark: boolean) => CONFETTI_INKS.map((name: string) => (INKS as Inks)[name][dark ? 1 : 0])

const BOX = 100 * (1 + MARGIN * 2)
const ORIGIN = -100 * MARGIN
let serial = 0

export interface LiveMarkProps {
  look: Look & { image?: string }
  // The shape's definition (characters.js shapeOf); undefined for a photo.
  def?: unknown
  dark: boolean
  size: number
  seed: number
  state?: string
  // Also comes alive at rest (blinks, glances, fidgets, dozing) at the lively motion level.
  live?: boolean
  // A tap pokes it; a touch held on it pets it.
  pokeable?: boolean
  // The flat art.
  children: ReactNode
}

type Shown = { scene: Node[] } | { pose: Pose } | null

export function LiveMark({ look, def, dark, size, seed, state = 'idle', live = false, pokeable = false, children }: LiveMarkProps) {
  const onScreen = useOnScreen()
  const [shown, setShown] = useState<Shown>(null)
  const mark = useRef<Live | null>(null)
  const prefix = useRef('')
  if (prefix.current === '') prefix.current = `lm${serial += 1}`
  // What the paint callback reads: the newest look and mode.
  const now = useRef({ color: look.color, dark })
  now.current = { color: look.color, dark }
  const photo = look.image !== undefined
  const shapeKey = photo ? `image:${look.image}` : look.shape
  // The values the mark is made with, without making it again when they change.
  const liveRef = useRef(live)
  liveRef.current = live
  const stateRef = useRef(state)
  stateRef.current = state
  const onScreenRef = useRef(onScreen)
  onScreenRef.current = onScreen

  useEffect(() => {
    const paint = (picture: Picture | null) => {
      if (picture === null) setShown(null)
      else if (picture.pose) setShown({ pose: picture.pose })
      else setShown({ scene: paintShapes(picture.shapes, inkOf(now.current.color, now.current.dark), confettiOf(now.current.dark)) })
    }
    const live = new Live(avatarClock, { look: { shape: photo ? 'image' : look.shape, color: look.color }, def: photo ? undefined : def, size, seed, live: liveRef.current, state: stateRef.current, turns: !photo, visible: onScreenRef.current, paint })
    mark.current = live
    return () => { live.destroy(); mark.current = null; setShown(null) }
  }, [shapeKey])
  useEffect(() => { mark.current?.update({ look: photo ? undefined : { shape: look.shape, color: look.color }, def: photo ? undefined : def, size, live, state }) }, [look.color, size, live, state])
  useEffect(() => { mark.current?.setVisible(onScreen) }, [onScreen])
  useEffect(() => { mark.current?.redraw() }, [dark])

  const petting = useRef(false)
  const touch = pokeable ? {
    onPress: () => mark.current?.act(engine => engine.poke()),
    onLongPress: (event: GestureResponderEvent) => {
      petting.current = true
      const side = event.nativeEvent.locationX < size / 2 ? -1 : 1
      mark.current?.act(engine => engine.pet(true, side))
    },
    onPressOut: () => {
      if (!petting.current) return
      petting.current = false
      mark.current?.act(engine => engine.pet(false))
    },
    delayLongPress: 280,
  } : null

  const scene = shown !== null && 'scene' in shown ? shown.scene : null
  const pose = shown !== null && 'pose' in shown ? shown.pose : null
  const art = scene ? null : pose
    ? <View style={{ width: size, height: size, transformOrigin: FLAT_ORIGIN, transform: [{ translateX: (pose.x / 100) * size }, { translateY: (pose.y / 100) * size }, { rotate: `${pose.roll}deg` }, { scaleX: pose.sx }, { scaleY: pose.sy }] }}>{children}</View>
    : children
  const drawing = scene ? (
    <Svg pointerEvents="none" width={size * BOX / 100} height={size * BOX / 100} viewBox={`${ORIGIN} ${ORIGIN} ${BOX} ${BOX}`} style={{ position: 'absolute', left: size * -MARGIN, top: size * -MARGIN }}>
      <Scene nodes={scene} prefix={prefix.current} />
    </Svg>
  ) : null
  const box = { width: size, height: size }
  if (touch) return <Pressable accessible={false} style={box} {...touch}>{art}{drawing}</Pressable>
  return <View style={box}>{art}{drawing}</View>
}

// The recorded paint (paint.ts) as SVG elements: gradients, clips, and masks go in Defs.
function Scene({ nodes, prefix }: { nodes: Node[]; prefix: string }) {
  let count = 0
  const defs: ReactElement[] = []
  const paintOf = (ink: Ink | undefined) => {
    if (ink === undefined) return 'none'
    if (typeof ink === 'string') return ink
    const id = `${prefix}g${count += 1}`
    defs.push(
      <LinearGradient key={id} id={id} gradientUnits="userSpaceOnUse" x1={ink.from[0]} y1={ink.from[1]} x2={ink.to[0]} y2={ink.to[1]}>
        {ink.stops.map(([offset, color], index) => <Stop key={index} offset={offset} stopColor={color} />)}
      </LinearGradient>,
    )
    return `url(#${id})`
  }
  const draw = (list: Node[], key: string): ReactElement[] => list.map((node, index) => {
    const at = `${key}.${index}`
    if ('op' in node) {
      const { op } = node
      return (
        <Path key={at} d={op.d} fill={op.fill === undefined ? 'none' : paintOf(op.fill)} stroke={op.stroke === undefined ? undefined : paintOf(op.stroke)}
          strokeWidth={op.width} strokeLinecap={op.cap as 'butt' | 'round' | 'square' | undefined} strokeLinejoin={op.join as 'miter' | 'round' | 'bevel' | undefined}
          opacity={op.alpha === 1 ? undefined : op.alpha} />
      )
    }
    if ('clip' in node) {
      const id = `${prefix}c${count += 1}`
      defs.push(<ClipPath key={id} id={id}><Path d={node.clip} /></ClipPath>)
      return <G key={at} clipPath={`url(#${id})`}>{draw(node.nodes, at)}</G>
    }
    const id = `${prefix}m${count += 1}`
    defs.push(
      <Mask key={id} id={id} maskUnits="userSpaceOnUse" x={ORIGIN} y={ORIGIN} width={BOX} height={BOX}>
        <Rect x={ORIGIN} y={ORIGIN} width={BOX} height={BOX} fill="#fff" />
        {node.cut.map((cut, index) => <Path key={index} d={cut.d} fill="#000" opacity={cut.alpha === 1 ? undefined : cut.alpha} />)}
      </Mask>,
    )
    return <G key={at} mask={`url(#${id})`}>{draw(node.nodes, at)}</G>
  })
  const body = draw(nodes, 'n')
  return <><Defs>{defs}</Defs>{body}</>
}
