#include "level1_simulator.h"

namespace circloo {

Level1Simulator::Level1Simulator()
    : model_(MakeLevel1ReferenceModel()), simulator_(model_) {}

} // namespace circloo
