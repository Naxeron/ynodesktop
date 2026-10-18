#include <iostream>
#include <set>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0002.lmu", "");
    if (!map) return 1;
    std::set<int> codes;
    for (const auto& ev : map->events) {
        for (const auto& page : ev.pages) {
            for (const auto& cmd : page.event_commands) {
                codes.insert(cmd.code);
            }
        }
    }
    for (int c : codes) std::cout << c << "\n";
    return 0;
}
