import { ZoomIn } from 'react-native-reanimated'
import { SPRING_POP } from './tokens.ts'

// SPRING_POP (ui-standard 9.1) as an entry builder for a small mark: builders
// take damping and stiffness at mass 1; the spring constants stay in tokens.ts.
export const PopIn = ZoomIn.springify().damping(SPRING_POP.damping).stiffness(SPRING_POP.stiffness)
