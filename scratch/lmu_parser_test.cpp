// Tests command extraction using liblcf types, without inventing an LMU parser.
#define main lmu_parser_program_main
#include "lmu_parser.cpp"
#undef main
#include <sstream>

lcf::rpg::EventCommand command(lcf::rpg::EventCommand::Code code, std::initializer_list<int> parameters) {
    lcf::rpg::EventCommand result;
    result.code = static_cast<int>(code);
    result.parameters = parameters;
    return result;
}

int main() {
    using Code = lcf::rpg::EventCommand::Code;
    std::unordered_map<int, std::vector<lcf::rpg::EventCommand>> common_events;
    common_events[41] = { command(Code::Teleport, {10, 9, 27}), command(Code::CallEvent, {0, 42, 0}) };
    common_events[42] = { command(Code::CallEvent, {0, 41, 0}) };
    const auto extract = [&](const std::vector<lcf::rpg::EventCommand>& commands) {
        std::ostringstream output;
        auto* previous = std::cout.rdbuf(output.rdbuf());
        bool first = true;
        std::unordered_set<int> visited;
        check_commands(commands, 3, 4, common_events, first, visited);
        std::cout.rdbuf(previous);
        return output.str();
    };
    const std::string expected = "    { \"targetMapId\": 10, \"startX\": 3, \"startY\": 4, \"targetX\": 9, \"targetY\": 27 }";
    if (extract({command(Code::CallEvent, {0, 41, 0})}) != expected) {
        std::cerr << "Literal common event extraction or cycle handling failed\n";
        return 1;
    }
    if (extract({command(Code::Teleport, {10, 9, 27})}) != expected) {
        std::cerr << "Direct teleport extraction failed\n";
        return 1;
    }
    // Vehicle commands, variable-based calls, map-event calls and malformed
    // commands must not be mistaken for literal common-event references.
    if (!extract({
        command(Code::EnterExitVehicle, {41}),
        command(Code::CallEvent, {1, 41, 0}),
        command(Code::CallEvent, {2, 41, 0}),
        command(Code::CallEvent, {3, 41, 0}),
        command(Code::CallEvent, {4, 41, 0}),
        command(Code::CallEvent, {0, 41}),
        command(Code::CallEvent, {0, 99999, 0}),
        command(Code::Teleport, {10, 9})
    }).empty()) {
        std::cerr << "Unsupported or malformed commands produced false teleports\n";
        return 1;
    }
    std::cout << "LMU command extraction checks passed\n";
    return 0;
}
