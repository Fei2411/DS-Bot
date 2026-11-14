import { ZoomIn } from 'react-native-reanimated'
import { SPRING_POP } from './tokens.ts'

// Builders take damping and stiffness at mass 1; the spring constants stay in
// tokens.ts.
export const PopIn = ZoomIn.springify().damping(SPRING_POP.damping).stiffness(SPRING_POP.stiffness)
